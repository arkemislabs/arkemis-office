// Typing, Enter, Tab, deleting and typed symbols: what the `text.*` commands do.
//
// Translated from wordcraft (ArtCraft commit aadb077e072b7de05f724e359d8db82e151f125c):
//   crates/engine/src/cmd/text/autoformat.rs  autoformat (smart quotes), typing_options, insert,
//                                             list_autoformat, double_space_period, dash_autoformat,
//                                             border_line, table_line, heading_line,
//                                             apply_heading_line, apply_border_line,
//                                             delete_typed_line, apply_table_line
//   crates/engine/src/cmd/text/enter_tab.rs   sample_text, new_paragraph, insert_paragraphs, enter,
//                                             tab, tab_indent_on, tab_indents, indent_by_tab, back_tab
//   crates/engine/src/cmd/text/delete.rs      backspace, remove_number, delete, delete_word_back,
//                                             delete_word_fwd
//   crates/engine/src/cmd/text/unicode.rs     toggle_unicode, insert_code, alt_code_char,
//                                             windows_code_pages, oem_code_page, hex_char, codeable,
//                                             code_of, ins_char
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Undo: upstream records an automatic change (AutoCorrect, a list from "1. ", a dash, a border or
// table line, a heading) as its own "AutoFormat" step after the plain typing or Enter, so Undo
// right after it brings back what was typed. Functions here report that boundary through
// `S.checkpoint(label)` (the command commits what is done so far as one undo step there; see
// core/quill/commands/text.mjs). They also report through `S.autoFormat = true` that one happened.

import {CommandError} from '../../kernel/errors.mjs';
import * as P from '../model/para.mjs';
import {Document} from '../model/document.mjs';
import {levelOf, findKind, addList, listKindIsBullet} from '../model/numbering.mjs';
import {insertRow, newTable} from '../model/table.mjs';
import {paraCancelCharIndents, charWithoutSymbol} from '../model/props.mjs';
import {windowsByte, oemByte, SINGLE_BYTE_CODE_PAGES, OEM_CODE_PAGES} from '../model/encoding.mjs';
import {getStyle} from '../model/styles.mjs';
import {textWidth as sectionTextWidth} from '../model/section.mjs';
import {caret, isCollapsed, ordered, samePos, samePath, at, withLast, cellOf, layoutFor} from './caret-session.mjs';
import {typingPrefs, paraAt, rp, trackChanges, newRevision, setPara, setMark, deleteSelection, deleteSelectionEffect, typeText,
  insertText, leaveList, splitPara, indent, enforced, prepareEdit, refusesParagraph, restorePlaceholder} from './text-edit.mjs';
import {autocorrect, autocorrectWord, hasEmphasis, noteBackspace} from './text-autocorrect.mjs';

const OBJ = P.OBJ;
export const MAX_TYPED_PARAGRAPHS = 10_000;
/** Most columns a table holds (wordcraft_doc::table::MAX_COLS). */
const MAX_COLS = 63;

const checkpoint = (S, label) => { if (typeof S.checkpoint === 'function') S.checkpoint(label); };

// ---- typing (autoformat.rs) -------------------------------------------------------------------------

/** Smart quotes as you type: a typed " or ' becomes the opening or closing curly quote (autoformat). */
export function smartQuote(S, text) {
  if ([...text].length !== 1) return null;
  const c = text;
  const ac = typingPrefs(S.prefs).autocorrect;
  if (!ac.enabled || !ac.smartQuotes) return null;
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para) return null;
  const prev = [...para.text.slice(0, f.off)].pop();
  const opening = prev === undefined || /\s/u.test(prev) || '([{<—–«‹„‚'.includes(prev)
    || (c === '"' && prev === '‘') || (c === '\'' && prev === '“');
  if (c === '"') return opening ? '“' : '”';
  if (c === '\'') return opening ? '‘' : '’';
  return null;
}

/** "Typing replaces selected text" off leaves the selection; overtype selects what the text replaces (typing_options). */
export function typingOptions(S, text) {
  const prefs = typingPrefs(S.prefs);
  if (!isCollapsed(S.sel)) {
    if (!prefs.typingReplacesSelection) S.sel = caret(ordered(S.sel)[0]);
    return;
  }
  if (!prefs.overtype || /[\r\n\u2029\u000B]/.test(text)) return;
  const f = S.sel.focus;
  const rest = paraAt(S, f)?.text.slice(f.off) ?? '';
  const n = [...text].length;
  let len = 0, k = 0;
  for (const ch of rest) { if (k >= n || ch === OBJ) break; len += ch.length; k++; }
  if (len > 0) S.sel = {anchor: at(f, f.off + len), focus: f};
}

/**
 * text.insert: type `text` at the selection as the keyboard does (smart quotes unless `raw`), or
 * with `paragraphs`, line by line with Enter between. A single space or punctuation mark then
 * runs list AutoFormat, AutoCorrect, dashes and the double-space period (insert).
 */
export function insert(S, text, {raw = false, paragraphs = false} = {}) {
  if (paragraphs) return insertParagraphs(S, text);
  typingOptions(S, text);
  const quote = raw ? null : smartQuote(S, text);
  const wasCollapsed = isCollapsed(S.sel);
  const effect = typeText(S, quote ?? text);
  S.view.pending = null;
  const trigger = [...text].length === 1 && (text === ' ' || ',.;:!?'.includes(text));
  if (raw || !trigger) return {...effect, transformed: quote !== null};
  const f = S.sel.focus;
  const typed = paraAt(S, f);
  // The paragraph as typed is its own undo step when an automatic change follows.
  checkpoint(S, 'Typing');
  const ac = typingPrefs(S.prefs).autocorrect;
  const listed = text === ' ' && ac.enabled && listAutoformat(S);
  if (!listed) autocorrect(S);
  const dashed = text === ' ' && !listed && ac.enabled && ac.dashes && dashAutoformat(S);
  if (text === ' ' && !listed && wasCollapsed && ac.enabled && ac.doubleSpacePeriod) doubleSpacePeriod(S);
  const rewritten = !!typed && paraAt(S, f) !== typed;
  if (listed || dashed || rewritten) S.autoFormat = true;
  if (S.view.autocap?.fresh) S.view.autocap = {...S.view.autocap, fresh: false};
  return {contentChanged: true, transformed: listed || dashed || rewritten || quote !== null};
}

/** "* " / "- " / "> " → bullets, "1. " / "a) " → numbering, typed at a paragraph's start (list_autoformat). */
function listAutoformat(S) {
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para) return false;
  const r = rp(S, para).numbering;
  if (r && r.num !== 0) return false;
  const kinds = {'* ': 'bullet', '- ': {bulletChar: '-'}, '> ': {bulletChar: '➢'}, '-> ': {bulletChar: '➔'}, '=> ': {bulletChar: '⇨'},
    '1. ': 'numbered', '1) ': 'numberedParen', 'a. ': 'lowerLetterDot', 'a) ': 'lowerLetter', 'A. ': 'upperLetter', 'i. ': 'lowerRoman', 'I. ': 'outline'};
  const kind = kinds[para.text.slice(0, f.off)];
  if (!kind) return false;
  const ac = typingPrefs(S.prefs).autocorrect;
  const bullet = listKindIsBullet(kind);
  if (!(bullet ? ac.bullets : ac.numbering)) return false;
  // Bullets join an existing bullet list; typing "1. " always starts numbering again at 1.
  let num = bullet ? findKind(S.d.c.numbering, kind) : null;
  if (num === null || num === undefined) {
    const made = addList(S.d.c.numbering, kind);
    S.d.setField('numbering', made.numbering);
    num = made.num;
  }
  S.d.deleteRange(at(f, 0), f);
  setPara(S, f.story, f.path, pr => {
    pr.numbering = {num, level: 0};
    // A heading stays a heading ("1. " in a Heading 1 gives a numbered Heading 1).
    if (!pr.style || pr.style === 'Normal') pr.style = 'ListParagraph';
    return pr;
  });
  S.sel = caret(at(f, 0));
  return true;
}

/** "word" + two spaces → "word. " (double_space_period). */
function doubleSpacePeriod(S) {
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para) return;
  const before = para.text.slice(0, f.off);
  if (!before.endsWith('  ')) return;
  const word = before.slice(0, -2);
  const last = [...word].pop();
  if (!last || !(/[\p{Alphabetic}\p{N}]/u.test(last) || ')]}"\'”’»›'.includes(last))) return;
  const off = word.length;
  const props = charWithoutSymbol(P.propsAt(para, off + 1) ?? {});
  S.d.deleteRange(at(f, off), at(f, off + 1));
  S.d.insertText(at(f, off), '.', props);
  S.sel = caret(f);
}

/** "word -- word" / "word - word" → en dash, "word--word" → em dash, on the space after (dash_autoformat). */
function dashAutoformat(S) {
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para) return false;
  const before = para.text.slice(0, f.off);
  if (!before.endsWith(' ')) return false;
  const t = before.trimEnd();
  let i = t.lastIndexOf(' -- ');
  if (i >= 0 && t.slice(i + 4) && !t.slice(i + 4).includes(' ')) {
    const props = charWithoutSymbol(P.propsAt(para, i + 1) ?? {});
    S.d.deleteRange(at(f, i + 1), at(f, i + 3));
    S.d.insertText(at(f, i + 1), '–', props);
    S.sel = caret(at(f, f.off + 1 - 2));
    return true;
  }
  i = t.lastIndexOf(' - ');
  if (i >= 0 && !t.slice(i + 3).includes(' ')) {
    const props = charWithoutSymbol(P.propsAt(para, i + 1) ?? {});
    S.d.deleteRange(at(f, i + 1), at(f, i + 2));
    S.d.insertText(at(f, i + 1), '–', props);
    S.sel = caret(f);
    return true;
  }
  i = t.lastIndexOf('--');
  if (i > 0 && [...t.slice(0, i)].pop() !== ' ') {
    const props = charWithoutSymbol(P.propsAt(para, i) ?? {});
    S.d.deleteRange(at(f, i), at(f, i + 2));
    S.d.insertText(at(f, i), '—', props);
    S.sel = caret(at(f, f.off - 1));
    return true;
  }
  return false;
}

// ---- Enter AutoFormat (autoformat.rs) ---------------------------------------------------------------

const hasDeletion = para => P.runRanges(para).some(([, , c]) => (c?.del ?? null) !== null);

/** Enter after "---", "___", "===", "***", "~~~" or "###": a bottom border (border_line). */
export function borderLine(S, pos) {
  const para = paraAt(S, pos);
  if (!para) return null;
  const text = para.text;
  const c = text[0];
  const ac = typingPrefs(S.prefs).autocorrect;
  const num = rp(S, para).numbering;
  if (!ac.enabled || !ac.borderLines || pos.off !== text.length || text.length < 3 || ![...text].every(x => x === c)
    || (num && num.num !== 0) || hasDeletion(para)) return null;
  const st = {'-': ['single', 0.75], '_': ['thick', 1.5], '=': ['double', 0.75], '*': ['dotted', 2.25], '~': ['wave', 0.75], '#': ['triple', 0.75]}[c];
  return st ? {style: st[0], width: st[1], color: null, space: 1} : null;
}

/** A body paragraph that is exactly "+---+-----+": the hyphen count of each column (table_line). */
export function tableLine(S, pos) {
  const para = paraAt(S, pos);
  if (!para) return null;
  const text = para.text;
  const num = rp(S, para).numbering;
  if (!typingPrefs(S.prefs).autocorrect.enabled || pos.story !== 'body' || pos.path.length !== 1 || pos.off !== text.length
    || (num && num.num !== 0) || hasDeletion(para)) return null;
  if (!text.startsWith('+') || !text.endsWith('+') || text.length < 2) return null;
  const cols = [];
  for (const run of text.slice(1, -1).split('+')) {
    if (!run || !/^-+$/.test(run) || cols.length >= MAX_COLS) return null;
    cols.push(run.length);
  }
  return cols;
}

/** Enter in an empty body paragraph after a short Normal line: Heading 1–3 (heading_line). */
export function headingLine(S, pos) {
  const ac = typingPrefs(S.prefs).autocorrect;
  const cur = paraAt(S, pos);
  const i = pos.path[pos.path.length - 1];
  if (!ac.enabled || !ac.headingStyles || pos.story !== 'body' || pos.path.length !== 1 || i === 0 || !cur || cur.text.length) return null;
  const prev = S.d.block(pos.story, withLast(pos.path, i - 1));
  if (prev?.kind !== 'para') return null;
  const plain = p => {
    const r = rp(S, p);
    return (!p.props?.style || p.props.style === 'Normal') && (!r.numbering || r.numbering.num === 0) && (r.outlineLevel === undefined || r.outlineLevel === null || r.outlineLevel >= 9);
  };
  const text = prev.text.replace(/^\t+/, '');
  const tabs = prev.text.length - text.length;
  const words = text.split(/\s+/u).filter(Boolean).length;
  const lastC = [...text].pop();
  if (!plain(cur) || !plain(prev) || prev.objects?.length || prev.section || hasDeletion(prev) || tabs > 2 || words < 1 || words > 5
    || /^\s/u.test(text) || /\p{Cc}/u.test(text) || !lastC || !/[\p{Alphabetic}\p{N}]/u.test(lastC)) return null;
  const level = tabs + 1;
  if (enforced(S) && S.d.c.settings?.protectFormatting && getStyle(S.d.c.styles, `Heading${level}`)?.locked) return null;
  return level;
}

/** Give the paragraph before the empty one at `pos` Heading `level` without its tabs (apply_heading_line). */
function applyHeadingLine(S, pos, level) {
  const prev = withLast(pos.path, Math.max(pos.path[pos.path.length - 1] - 1, 0));
  const before = S.d.para(pos.story, prev);
  if (!before) return;
  const tabs = before.text.length - before.text.replace(/^\t+/, '').length;
  const start = {story: pos.story, path: prev, off: 0};
  S.sel = {anchor: start, focus: at(start, tabs)};
  deleteSelection(S);
  setPara(S, pos.story, prev, pr => {
    // set_heading: the heading style, out of any list it was in.
    pr.style = `Heading${level}`;
    delete pr.numbering;
    delete pr.outlineLevel;
    return pr;
  });
  const after = S.d.para(pos.story, prev);
  if (trackChanges(S) && typingPrefs(S.prefs).trackFormatting && after && after.text !== before.text && !after.props?.fmtChange) {
    const rev = newRevision(S, 'format');
    setPara(S, pos.story, prev, pr => ({...pr, fmtChange: {rev, old: formattingOf(before.props)}}));
  }
  S.sel = caret(at(pos, pos.off));
}

const formattingOf = props => { const o = {...(props ?? {})}; delete o.numChange; delete o.fmtChange; return o; };

/** Delete the AutoFormat characters of the paragraph at `pos` (tracked); returns the end left (delete_typed_line). */
function deleteTypedLine(S, pos) {
  const len = S.d.para(pos.story, pos.path)?.text.length ?? 0;
  S.sel = {anchor: at(pos, 0), focus: at(pos, len)};
  deleteSelection(S);
  return at(pos, S.d.para(pos.story, pos.path)?.text.length ?? 0);
}

/** Turn the border-line characters into a bottom border on the paragraph above (or this one) (apply_border_line). */
function applyBorderLine(S, pos, line) {
  const setBottom = (story, path) => setPara(S, story, path, pr => ({...pr, borders: {...(pr.borders ?? {}), bottom: line}}));
  const i = pos.path[pos.path.length - 1];
  const prev = i > 0 ? withLast(pos.path, i - 1) : null;
  const end = deleteTypedLine(S, pos);
  if (prev && S.d.block(pos.story, prev)?.kind === 'para') {
    setBottom(pos.story, prev);
    S.sel = caret(end);
    return;
  }
  const before = S.d.para(pos.story, pos.path)?.props ?? {};
  setBottom(pos.story, pos.path);
  const nw = splitPara(S, end);
  setPara(S, nw.story, nw.path, pr => { delete pr.borders; return pr; });
  if (trackChanges(S) && typingPrefs(S.prefs).trackFormatting && !before.fmtChange) {
    const rev = newRevision(S, 'format');
    setPara(S, pos.story, pos.path, pr => ({...pr, fmtChange: {rev, old: formattingOf(before)}}));
  }
  S.sel = caret(nw);
}

/** Replace the "+---+" characters with a one-row table across the text width (apply_table_line). */
function applyTableLine(S, pos, cols) {
  const total = Math.max(cols.reduce((a, b) => a + b, 0), 1);
  const block = pos.path[0] ?? 0;
  const sect = S.d.sectionOfBlock(block);
  const width = Math.max(sect ? sectionTextWidth(sect) : 468, 36);
  let t = newTable(1, cols.length, width, () => S.d.newId());
  t = {...t, grid: cols.map(d => Math.max(width * d / total, 6)), rows: t.rows.map(r => ({...r, cells: r.cells.map((c, k) => ({...c, props: {...c.props, width: Math.max(width * cols[k] / total, 6)}}))}))};
  deleteTypedLine(S, pos);
  S.d.insertBlock(pos.story, pos.path, t);
  S.sel = caret({story: pos.story, path: [...pos.path, 0, 0, 0], off: 0});
}

// ---- Enter (enter_tab.rs) -----------------------------------------------------------------------------

const SAMPLE = {
  '=rand(': ['A blank page leaves room for a new idea.', 'The morning light falls across a notebook on the desk.', 'Small changes in spacing can give a story a different rhythm.'],
  '=lorem(': ['Lorem ipsum dolor sit amet, consectetur adipiscing elit.', 'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.'],
};

/** =rand() and =lorem() sample text: the text Enter types instead, or null (sample_text). */
export function sampleText(S) {
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para || !isCollapsed(S.sel) || f.off !== para.text.length) return null;
  const prefix = para.text.startsWith('=rand(') ? '=rand(' : para.text.startsWith('=lorem(') ? '=lorem(' : null;
  if (!prefix || !para.text.endsWith(')')) return null;
  const args = para.text.slice(prefix.length, -1);
  if (/[()]/.test(args)) return null;
  const count = a => { const t = a.trim(); if (!/^\d+$/.test(t)) return null; const n = Number(t); return n >= 1 && n <= 200 ? n : null; };
  let counts;
  if (!args) counts = [5, 3];
  else if (args.includes(',')) { const k = args.indexOf(','); const a = count(args.slice(0, k)), b = count(args.slice(k + 1)); counts = a && b ? [a, b] : null; }
  else { const a = count(args); counts = a ? [a, 3] : null; }
  const [paragraphs, lines] = counts ?? [5, 3];
  const sentences = SAMPLE[prefix];
  let text = '';
  for (let i = 0; i < paragraphs; i++) {
    for (let k = 0; k < lines; k++) {
      if (text && !text.endsWith('\r')) text += ' ';
      text += sentences[k % sentences.length];
    }
    text += '\r';
  }
  return text;
}

/** text.newParagraph: Enter, unless the selection is in a control that takes no paragraph break (new_paragraph). */
export function newParagraph(S) {
  if (refusesParagraph(S)) return;
  enter(S, true);
  S.view.pending = null;
}

/** text.insert with `paragraphs`: each line typed raw, Enter between, one undo step (insert_paragraphs). */
export function insertParagraphs(S, text0) {
  const text = text0.replace(/\r\n/g, '\n');
  const lines = text.split(/[\n\r\u2029]/);
  if (lines.length > MAX_TYPED_PARAGRAPHS) {
    throw new CommandError('invalid_params', `text.insert: \`text\` has ${lines.length} lines; type at most ${MAX_TYPED_PARAGRAPHS} paragraphs per call`);
  }
  typingOptions(S, text);
  lines.forEach((ln, i) => {
    if (i > 0) {
      if (refusesParagraph(S)) throw new CommandError('disabled', 'text.insert: this content control takes no paragraph breaks');
      enter(S, false);
    }
    if (ln) typeText(S, ln);
  });
  return {contentChanged: true};
}

/**
 * Enter's paragraph break: sample text, AutoFormat of a border, table or heading line,
 * AutoCorrect of the word it ends, else a plain split (enter). With `undoStep` an automatic
 * change is its own undo step after the plain Enter.
 */
export function enter(S, undoStep) {
  prepareEdit(S);
  const sample = sampleText(S);
  if (sample !== null) {
    const end = S.sel.focus;
    S.sel = {anchor: at(end, 0), focus: end};
    typeText(S, sample);
    return;
  }
  let pos = deleteSelection(S);
  const border = borderLine(S, pos);
  const table = border ? null : tableLine(S, pos);
  const heading = border || table ? null : headingLine(S, pos);
  if (border || table || heading) {
    if (undoStep && typeof S.plainFirst === 'function') {
      // Word: Undo right after reverts only the AutoFormat; the plain Enter stays.
      S.plainFirst(T => { const nw = splitPara(T, pos); T.sel = caret(nw); });
    }
    if (border) applyBorderLine(S, pos, border);
    else if (table) applyTableLine(S, pos, table);
    else applyHeadingLine(S, pos, heading);
    S.view.goalX = null;
    S.autoFormat = true;
    return;
  }
  // Enter finishes a word as a space does ("teh" → "the", sentence capitals, links).
  let plainMark = null;
  if (isCollapsed(S.sel) && pos.off > 0) {
    if (hasEmphasis(S, true)) {
      // A `*bold*` or `_italic_` word: the new paragraph is formatted as after a plain Enter (the
      // closing mark's formatting, or none when the next style starts afresh).
      const T = {...S, d: new Document(S.d.c), sel: {...S.sel}, view: {...S.view}};
      const nw0 = splitPara(T, pos);
      plainMark = {...P.markOf(T.d.paraAt(nw0) ?? {})};
      if (undoStep && typeof S.plainFirst === 'function') {
        const at0 = pos;
        S.plainFirst(U => { const nw = splitPara(U, at0); U.sel = caret(nw); });
      }
    }
    const before = paraAt(S, pos);
    autocorrectWord(S, true);
    if (paraAt(S, pos) !== before) S.autoFormat = true;
    pos = S.sel.focus;
  }
  const nw = splitPara(S, pos);
  if (plainMark) {
    // Its mark keeps its own revisions.
    setMark(S, nw.story, nw.path, m => {
      const out = {...plainMark};
      delete out.ins; delete out.del; delete out.fmtChange;
      if (m.ins !== undefined) out.ins = m.ins;
      if (m.del !== undefined) out.del = m.del;
      if (m.fmtChange !== undefined) out.fmtChange = m.fmtChange;
      return out;
    });
  }
  S.sel = caret(nw);
  S.view.goalX = null;
}

// ---- Tab (enter_tab.rs) --------------------------------------------------------------------------------

/** Is "Set left- and first-indent with tabs and backspaces" on? (tab_indent_on) */
export function tabIndentOn(S) {
  const ac = typingPrefs(S.prefs).autocorrect;
  return ac.enabled && ac.tabIndent && !(enforced(S) && S.d.c.settings?.protectFormatting);
}

/** Does Tab at `f` indent instead of typing a tab? (tab_indents) */
function tabIndents(S, f) {
  const para = paraAt(S, f);
  if (!para || para.text.length === 0) return false;
  if (f.off === 0) { const n = rp(S, para).numbering; return !n || n.num === 0; }
  const b = S.layout()?.lineBounds(f, S.view.pageHint);
  return !!b && samePos(b[0], f);
}

/** Tab before a line with the option on (indent_by_tab). */
function indentByTab(S, f) {
  const para = paraAt(S, f);
  if (!para) return;
  const r = rp(S, para);
  if (f.off > 0 && !para.props?.numbering && r.numbering && r.numbering.num !== 0) {
    setPara(S, f.story, f.path, pr => ({...pr, numbering: {num: r.numbering.num, level: Math.min(r.numbering.level + 1, 8)}}));
    return;
  }
  if (f.off === 0 && (r.indentFirst ?? 0) === 0 && (r.indentFirstChars ?? r.indentChars?.[2] ?? 0) === 0) {
    const tab = Math.max(S.d.c.settings?.defaultTab ?? 36, 1);
    setPara(S, f.story, f.path, pr => paraCancelCharIndents({...pr, indentFirst: tab}, false, false, true));
    return;
  }
  indent(S, 1);
}

/** Select a table cell's content (Tab into a cell). */
function selectCell(S, story, tpath, r, c) {
  const start = {story, path: [...tpath, r, c, 0], off: 0};
  const prefix = start.path.slice(0, -1);
  const paths = S.d.paraPaths(story);
  let endPath = null;
  for (let k = paths.length - 1; k >= 0; k--) if (samePath(paths[k].slice(0, prefix.length), prefix)) { endPath = paths[k]; break; }
  const end = endPath ? {story, path: endPath, off: S.d.para(story, endPath)?.text.length ?? 0} : start;
  S.sel = {anchor: start, focus: end};
}

/** Tab: next table cell (a row is added after the last), list level down, indent, or a tab character (tab). */
export function tab(S) {
  const cell = cellOf(S.sel.focus.path);
  if (cell) {
    const [tpath, r, c] = cell;
    const story = S.sel.focus.story;
    const t = S.d.table(story, tpath);
    if (!t) { insChar(S, '\t'); return; }
    const rowLen = t.rows[r]?.cells.length ?? 0;
    const [nr, nc] = c + 1 < rowLen ? [r, c + 1] : [r + 1, 0];
    if (nr >= t.rows.length) S.d.updateTable(story, tpath, tb => insertRow(tb, nr, r, () => S.d.newId()));
    selectCell(S, story, tpath, nr, nc);
    return;
  }
  const f = S.sel.focus;
  const n = paraAt(S, f)?.props?.numbering;
  if (isCollapsed(S.sel) && f.off === 0 && n && n.num !== 0) {
    setPara(S, f.story, f.path, pr => ({...pr, numbering: {num: n.num, level: Math.min(n.level + 1, 8)}}));
    return;
  }
  if (isCollapsed(S.sel) && tabIndentOn(S) && tabIndents(S, f)) { indentByTab(S, f); return; }
  const [a, b] = ordered(S.sel);
  const samePara = samePath(S.sel.anchor.path, S.sel.focus.path);
  const wholePara = !isCollapsed(S.sel) && samePara && a.off === 0 && paraAt(S, a)?.text.length === b.off;
  if (!isCollapsed(S.sel) && (!samePara || wholePara)) { indent(S, 1); return; }
  insChar(S, '\t');
}

/** Shift+Tab: previous table cell, list level up, or decrease indent (back_tab). */
export function backTab(S) {
  const cell = cellOf(S.sel.focus.path);
  if (cell) {
    const [tpath, r, c] = cell;
    const story = S.sel.focus.story;
    let nr, nc;
    if (c > 0) [nr, nc] = [r, c - 1];
    else if (r > 0) [nr, nc] = [r - 1, Math.max((S.d.table(story, tpath)?.rows[r - 1]?.cells.length ?? 1) - 1, 0)];
    else return;
    S.sel = caret({story, path: [...tpath, nr, nc, 0], off: 0});
    return;
  }
  const f = S.sel.focus;
  const n = paraAt(S, f)?.props?.numbering;
  if (n && n.num !== 0) {
    setPara(S, f.story, f.path, pr => ({...pr, numbering: {num: n.num, level: Math.max(n.level - 1, 0)}}));
    return;
  }
  indent(S, -1);
}

// ---- deleting (delete.rs) -------------------------------------------------------------------------------

/** The first Backspace at a numbered paragraph's start removes the number, keeping its indent (remove_number). */
function removeNumber(S, f, n) {
  const textAt = levelOf(S.d.c.numbering, n.num, n.level)?.indent ?? null;
  setPara(S, f.story, f.path, pr => {
    if (pr.style === 'ListParagraph') {
      if (pr.indentLeft === undefined && !(pr.indentLeftChars > 0) && textAt !== null) pr.indentLeft = textAt;
      if (pr.indentFirst === undefined && !(pr.indentFirstChars > 0)) pr.indentFirst = 0;
    }
    pr.numbering = {num: 0, level: 0};
    return pr;
  });
}

/** Backspace (backspace + restore_placeholder). */
export function backspace(S) {
  backspaceInner(S);
  restorePlaceholder(S);
}

function backspaceInner(S) {
  S.view.goalX = null;
  S.view.pending = null;
  if (!isCollapsed(S.sel)) { deleteSelectionEffect(S); return; }
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para) return;
  if (f.off > 0) {
    const a = at(f, P.backspaceFrom(para, f.off));
    noteBackspace(S, a, f);
    S.sel = {anchor: a, focus: f};
    deleteSelectionEffect(S);
    return;
  }
  const n = para.props?.numbering;
  if (n && n.num !== 0) { removeNumber(S, f, n); return; }
  if (para.props?.style === 'ListParagraph') { leaveList(S, f.story, f.path); return; }
  if ((para.props?.indentFirst ?? 0) > 0 || (para.props?.indentFirstChars ?? 0) > 0) {
    setPara(S, f.story, f.path, pr => paraCancelCharIndents({...pr, indentFirst: 0}, false, false, true));
    return;
  }
  if (tabIndentOn(S) && ((para.props?.indentLeft ?? 0) > 0 || (para.props?.indentLeftChars ?? 0) > 0)) { indent(S, -1); return; }
  const i = f.path[f.path.length - 1];
  if (i === 0) return;
  const prevPath = withLast(f.path, i - 1);
  const prev = S.d.block(f.story, prevPath);
  if (prev?.kind === 'para') {
    const a = {story: f.story, path: prevPath, off: prev.text.length};
    if (trackChanges(S)) { S.sel = {anchor: a, focus: f}; deleteSelection(S); return; }
    S.sel = caret(S.d.deleteRange(a, f));
  } else if (prev?.kind === 'table') {
    const paths = S.d.paraPaths(f.story);
    let q = null;
    for (let k = paths.length - 1; k >= 0; k--) {
      const c = paths[k];
      if (c.length > prevPath.length && samePath(c.slice(0, prevPath.length), prevPath)) { q = c; break; }
    }
    if (q) {
      const off = S.d.para(f.story, q)?.text.length ?? 0;
      if (para.text.length === 0 && (S.d.container(f.story, f.path)?.len() ?? 0) > i + 1) S.d.removeBlock(f.story, f.path);
      S.sel = caret({story: f.story, path: q, off});
    }
  }
}

/** Delete (delete + restore_placeholder). */
export function del(S) {
  deleteInner(S);
  restorePlaceholder(S);
}

function deleteInner(S) {
  S.view.goalX = null;
  S.view.pending = null;
  if (!isCollapsed(S.sel)) { deleteSelectionEffect(S); return; }
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para) return;
  if (f.off < para.text.length) {
    S.sel = {anchor: f, focus: at(f, P.nextBoundary(para, f.off))};
    deleteSelectionEffect(S);
    return;
  }
  const next = withLast(f.path, f.path[f.path.length - 1] + 1);
  const nb = S.d.block(f.story, next);
  if (nb?.kind === 'para') {
    const b = {story: f.story, path: next, off: 0};
    if (trackChanges(S)) {
      const blocks = S.d.container(f.story, f.path)?.len();
      S.sel = {anchor: f, focus: b};
      deleteSelection(S);
      if (S.d.container(f.story, f.path)?.len() === blocks && (S.d.paraAt(f)?.mark?.del ?? null) !== null) S.sel = caret(b);
      return;
    }
    S.sel = caret(S.d.deleteRange(f, b));
  } else if (nb?.kind === 'table') {
    if (para.text.length === 0 && f.path[f.path.length - 1] > 0) {
      S.d.removeBlock(f.story, f.path);
      const path = [...next];
      path[path.length - 1] -= 1;
      S.sel = caret({story: f.story, path: [...path, 0, 0, 0], off: 0});
    }
  } else if (f.story === 'body' && f.path.length === 1 && !trackChanges(S)) {
    // The last paragraph: a section break on its mark still goes (#2127).
    S.d.removeSectionBreak(f.path[0]);
  }
}

/** Ctrl+Backspace (delete_word_back). */
export function deleteWordBack(S) {
  if (!isCollapsed(S.sel)) return backspace(S);
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para) return;
  if (f.off === 0) return backspace(S);
  S.sel = {anchor: at(f, P.wordStart(para, f.off)), focus: f};
  deleteSelection(S);
  restorePlaceholder(S);
}

/** Ctrl+Delete (delete_word_fwd). */
export function deleteWordForward(S) {
  if (!isCollapsed(S.sel)) return del(S);
  const f = S.sel.focus;
  const para = paraAt(S, f);
  if (!para) return;
  if (f.off >= para.text.length) return del(S);
  S.sel = {anchor: f, focus: at(f, P.wordEnd(para, f.off))};
  deleteSelection(S);
  restorePlaceholder(S);
}

// ---- typed symbols and character codes (unicode.rs) -------------------------------------------------------

/** A typed character (ins_char): type_text, no AutoFormat. */
export function insChar(S, ch) {
  return typeText(S, ch);
}

/** Characters Alt+X converts (codeable). */
const codeable = c => !/\p{Cc}/u.test(c) && c !== OBJ;
/** A character's code as Word writes it: at least four upper-case hex digits (code_of). */
const codeOf = c => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
/** The character a hex code (1–6 digits) names (hex_char). */
function hexChar(code) {
  if (!code || code.length > 6 || !/^[0-9a-fA-F]+$/.test(code)) return null;
  const n = parseInt(code, 16);
  if (n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return null;
  const c = String.fromCodePoint(n);
  return codeable(c) ? c : null;
}

/** Toggle Unicode Character (Alt+X): a hex code before the caret ↔ its character (toggle_unicode). */
export function toggleUnicode(S) {
  const [a, b] = ordered(S.sel);
  if (a.story !== b.story || !samePath(a.path, b.path)) throw new CommandError('failed', 'select a character code in one paragraph');
  const para = paraAt(S, b);
  if (!para) throw new CommandError('failed', 'no paragraph at the caret');
  let start, replacement;
  if (!samePos(a, b)) {
    const sel = para.text.slice(a.off, b.off);
    const code = sel.startsWith('U+') || sel.startsWith('u+') ? sel.slice(2) : sel;
    const c = hexChar(code);
    if (c) { start = a.off; replacement = c; } else {
      const cs = [...sel];
      if (cs.length === 1 && codeable(cs[0])) { start = a.off; replacement = codeOf(cs[0]); }
      else throw new CommandError('failed', 'select a character code (like 00E9) or one character');
    }
  } else {
    const before = para.text.slice(0, b.off);
    // The hex digits right before the caret (at most six); the longest that names a character wins.
    const m = /[0-9a-fA-F]{1,6}$/.exec(before);
    let found = null;
    if (m) {
      for (let k = m.index; k < before.length && !found; k++) {
        const c = hexChar(before.slice(k));
        if (c) { const prefixed = /[Uu]\+$/.test(before.slice(0, k)); found = [prefixed ? k - 2 : k, c]; }
      }
    }
    const last = [...before].pop();
    if (found) [start, replacement] = found;
    else if (last !== undefined && codeable(last)) { start = b.off - last.length; replacement = codeOf(last); }
    else throw new CommandError('failed', 'no character or code before the caret');
  }
  S.sel = {anchor: at(b, start), focus: b};
  S.view.pending = null;
  typeText(S, replacement);
}

/** The (ANSI, OEM) code pages Windows uses for a locale (windows_code_pages). */
export function windowsCodePages(locale) {
  if (!locale) return [1252, 437];
  const parts = String(locale).split(/[-_.@]/);
  const lang = (parts[0] ?? '').toLowerCase();
  const rest = parts.slice(1);
  const region = rest.find(p => /^[A-Za-z]{2}$/.test(p))?.toUpperCase();
  const script = rest.find(p => /^[A-Za-z]{4}$/.test(p))?.toLowerCase();
  const WESTERN = ['ca', 'da', 'de', 'es', 'eu', 'fi', 'fo', 'fr', 'ga', 'gl', 'is', 'it', 'nb', 'nl', 'nn', 'no', 'pt', 'sv'];
  if (lang === 'en') return !region || region === 'US' ? [1252, 437] : [1252, 850];
  if (WESTERN.includes(lang)) return [1252, 850];
  if (['pl', 'cs', 'sk', 'hu', 'sl', 'hr', 'ro', 'sq', 'bs'].includes(lang)) return [1250, 852];
  if (lang === 'sr' && script === 'latn') return [1250, 852];
  if (['ru', 'uk', 'be', 'bg'].includes(lang)) return [1251, 866];
  if (lang === 'sr' || lang === 'mk') return [1251, 437];
  if (lang === 'el') return [1253, 737];
  if (lang === 'az' && script === 'cyrl') return [1251, 866];
  if (lang === 'tr' || lang === 'az') return [1254, 857];
  if (lang === 'he') return [1255, 437];
  if (['ar', 'fa', 'ur'].includes(lang)) return [1256, 437];
  if (['et', 'lv', 'lt'].includes(lang)) return [1257, 437];
  if (lang === 'vi') return [1258, 437];
  if (lang === 'th') return [874, 437];
  return [1252, 437];
}

/** The OEM code page text.typeCode assumes for a locale (oem_code_page). */
export const oemCodePage = locale => (windowsCodePages(locale)[1] === 850 ? 850 : 437);

/** The character Word types for an Alt+numpad code, or null (alt_code_char). */
export function altCodeChar(code, ansi, oem) {
  if (!code || !/^\d+$/.test(code)) return null;
  const digits = code.replace(/^0+/, '');
  if (digits.length > 7) return null;
  const value = digits ? Number(digits) : 0;
  let c;
  if (value === 0) return null;
  if (value <= 255) c = code.startsWith('0') ? windowsByte(ansi, value) : oemByte(oem, value);
  else if (value > 0x10FFFF || (value >= 0xD800 && value <= 0xDFFF)) return null;
  else c = String.fromCodePoint(value);
  return c && codeable(c) && c !== '�' ? c : null;
}

/** text.typeCode (insert_code): the character as typed text; returns it. */
export function insertCode(S, p) {
  const page = (key, known, def) => {
    if (p[key] === undefined || p[key] === null) return def;
    if (!known.includes(p[key])) throw new CommandError('invalid_params', `${key} must be one of [${known.join(', ')}]`, {path: `/${key}`});
    return p[key];
  };
  const ansi = page('ansi', SINGLE_BYTE_CODE_PAGES, 1252);
  const oem = page('oem', OEM_CODE_PAGES, oemCodePage(S.prefs?.systemLocale ?? null));
  const c = altCodeChar(p.code, ansi, oem);
  if (!c) throw new CommandError('failed', `${JSON.stringify(p.code)} isn't a character code`);
  insert(S, c);
  return c;
}

export {autocorrect};
