// Keyboard on the slide: text-editing keys while editing text, nudges and selection keys
// otherwise, and typing (which starts editing a selected shape's text, replacing it). Shared by
// the surface and the bridge so a key does the same thing everywhere.
// Translated from deckcraft crates/engine/src/keys.rs (shortcut_matches, key_token, Session::key,
// text_key, type_text, commit_text, start_typing, cycle_selection, next_cell) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Foundation-owned (F:prism). No DOM, no Node built-ins.
//
// deckcraft's Session::key executes the commands itself; here `planKey` returns the steps (command
// ids and params, run in order by the caller through the registry) or a selection change
// (`select`), and `handled:false` when the key is the registry's (the shell's KeyRouter: format
// shortcuts, undo, the rest). Steps use the command families' ids verbatim (text.insert,
// text.move, text.delete, shape.move, edit.delete, text.edit, edit.deselect, slide.next, ...).

import {findShape} from '../model/presentation.mjs';
import {currentSlideId, selectedShapeIds, textSelection, slideById, shapeChain, selectShapes, selectSlides} from '../model/doc.mjs';
import {cellSelection} from './table-sel.mjs';

/** Does a shortcut like `Cmd+Shift+]` match `key` + `mods`? */
export function shortcutMatches(shortcut, key, mods) {
  const parts = String(shortcut).split('+');
  let k, ms;
  if (parts.length >= 2 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') { k = '+'; ms = parts.slice(0, -2); }
  else { k = parts[parts.length - 1]; ms = parts.slice(0, -1); }
  if (k === undefined) return false;
  const has = m => ms.some(x => x.toLowerCase() === m);
  return k.toLowerCase() === String(key).toLowerCase() && (has('cmd') || has('ctrl')) === !!mods.cmd && has('shift') === !!mods.shift
    && (has('alt') || has('option')) === !!mods.alt;
}

/** A key name in one spelling: lower case, `ArrowLeft` → `left`, punctuation names → the character. */
export function keyToken(key) {
  const k = String(key).toLowerCase().replace(/^arrow/, '');
  return {period: '.', '>': '.', comma: ',', '<': ',', openbracket: '[', '{': '[', closebracket: ']', '}': ']', equals: '=', minus: '-', plus: '+', slash: '/',
    backslash: '\\', semicolon: ';', quote: "'", backtick: '`'}[k] ?? k;
}

function state(content, selection) {
  const slideId = currentSlideId(content, selection);
  const t = textSelection(content, selection);
  return {slideId, slide: slideById(content, slideId), text: t, shapes: selectedShapeIds(content, selection)};
}

/**
 * The text-editing command for a navigation or deletion key while editing text, by platform:
 * Ctrl (Windows, Linux) or Option (Mac) moves and deletes by word; Ctrl+Up/Down moves by paragraph;
 * Ctrl+Home/End (Cmd+Up/Down on the Mac) go to the ends of the text and Cmd+Left/Right on the Mac
 * to the ends of the line. Shift extends the selection.
 */
export function textKey(k, mods, mac) {
  const word = mac ? mods.alt && !mods.cmd : mods.cmd && !mods.alt;
  const macCmd = mac && mods.cmd && !mods.alt;
  if (mods.cmd && !mods.alt && !mods.shift) {
    // Ctrl+] / Ctrl+[ grow and shrink the font, like Ctrl+Shift+> / <.
    if (k === ']') return {command: 'format.grow', params: {}};
    if (k === '[') return {command: 'format.shrink', params: {}};
  }
  const plain = !mods.cmd && !mods.alt;
  let to = null;
  if (k === 'left') to = word ? 'wordLeft' : macCmd ? 'lineStart' : plain ? 'left' : null;
  else if (k === 'right') to = word ? 'wordRight' : macCmd ? 'lineEnd' : plain ? 'right' : null;
  else if (k === 'up') to = macCmd ? 'start' : word && mac ? 'paraStart' : word ? 'paraUp' : plain ? 'up' : null;
  else if (k === 'down') to = macCmd ? 'end' : word && mac ? 'paraEnd' : word ? 'paraDown' : plain ? 'down' : null;
  else if (k === 'home') to = mods.cmd && !mods.alt ? 'start' : plain ? 'lineStart' : null;
  else if (k === 'end') to = mods.cmd && !mods.alt ? 'end' : plain ? 'lineEnd' : null;
  else if (k === 'backspace') return word ? {command: 'text.delete', params: {dir: 'wordBackward'}} : plain ? {command: 'text.delete', params: {dir: 'backward'}} : null;
  else if (k === 'delete') return word ? {command: 'text.delete', params: {dir: 'wordForward'}} : plain ? {command: 'text.delete', params: {dir: 'forward'}} : null;
  return to ? {command: 'text.move', params: {to, extend: !!mods.shift}} : null;
}

/** Tab / Shift+Tab: the next or previous visible shape on the slide becomes the selection. */
export function cycleSelection(content, selection, forward) {
  const st = state(content, selection);
  const ids = (st.slide?.shapes ?? []).filter(s => !s.hidden).map(s => s.id);
  if (!ids.length) return null;
  const cur = st.shapes.length ? ids.indexOf(st.shapes[0]) : -1;
  const n = ids.length;
  const next = cur >= 0 ? (forward ? (cur + 1) % n : (cur + n - 1) % n) : forward ? 0 : n - 1;
  return selectShapes(st.slideId, [shapeChain(st.slide, ids[next]) ?? [ids[next]]]);
}

/** Tab in a table cell: the next (or previous) uncovered cell; Tab in the last cell adds a row. */
function nextCell(content, st, back) {
  const t = st.text;
  const tb = findShape(st.slide?.shapes, t.shape)?.kind;
  if (!tb || tb.type !== 'table') return [];
  const nr = tb.rows.length, nc = Math.max(tb.cols.length, 1);
  const idx = t.cell[0] * nc + t.cell[1];
  const visible = i => { const c = tb.rows[Math.floor(i / nc)]?.cells?.[i % nc]; return !!c && !(c.hMerge || c.vMerge); };
  let ni = null;
  if (back) { for (let i = idx - 1; i >= 0; i--) if (visible(i)) { ni = i; break; } }
  else { for (let i = idx + 1; i < nr * nc; i++) if (visible(i)) { ni = i; break; } }
  if (ni === null && !back) {
    const last = Math.max(nr - 1, 0);
    return [{command: 'table.insertRowBelow', params: {id: t.shape, row: last}}, {command: 'text.edit', params: {id: t.shape, cell: [last + 1, 0]}}];
  }
  if (ni === null) ni = idx;
  return [{command: 'text.edit', params: {id: t.shape, cell: [Math.floor(ni / nc), ni % nc]}}, {command: 'text.selectAll', params: {}}];
}

/**
 * Plan one key press (deckcraft `Session::key`). `key` is a name (`Enter`, `Escape`, `Backspace`,
 * `Delete`, `Tab`, `ArrowLeft`…, `Home`, `End`, `PageUp`, `PageDown`, `F2`) or a character.
 * `tool` tells whether a freeform is being drawn (`drawingFreeform`). Returns
 * `{handled, steps?: [{command, params}], select?: Selection, finishFreeform?: true}`.
 */
export function planKey(content, selection, key, mods = {}, {mac = false, drawingFreeform = false} = {}) {
  const m = {shift: !!mods.shift, alt: !!mods.alt, cmd: !!mods.cmd};
  const k = keyToken(key);
  const st = state(content, selection);
  if (!st.slide) return {handled: false};
  if (drawingFreeform && ['enter', 'return', 'escape'].includes(k)) return {handled: true, finishFreeform: true};
  const editing = !!st.text;
  const hasShapes = st.shapes.length > 0;
  if (editing) {
    const tk = textKey(k, m, mac);
    if (tk) return {handled: true, steps: [tk]};
  }
  if (editing && !m.cmd) {
    if (k === 'enter' || k === 'return') return {handled: true, steps: [{command: 'text.insert', params: {text: m.shift ? '\u000b' : '\n'}}]};
    if (k === 'escape' || k === 'esc') return {handled: true, steps: [{command: 'text.exit', params: {}}]};
    if (k === 'tab') {
      // Tab at the start of a paragraph changes the list level; elsewhere it types a tab.
      const t = st.text;
      if (t.cell) return {handled: true, steps: nextCell(content, st, m.shift)};
      const body = t.notes ? st.slide.notes : findShape(st.slide.shapes, t.shape)?.text;
      const atStart = t.anchor !== t.caret || paraStart(body, Math.min(t.anchor, t.caret));
      return {handled: true, steps: [atStart ? {command: m.shift ? 'format.outdent' : 'format.indent', params: {}} : {command: 'text.insert', params: {text: '\t'}}]};
    }
  }
  // A selected range of table cells: Shift+arrow grows or shrinks it, Delete clears their text, Enter starts editing the first.
  const cells = !editing ? cellSelection(content, selection) : null;
  if (cells && !m.cmd) {
    const dir = {left: [0, -1], right: [0, 1], up: [-1, 0], down: [1, 0]}[k];
    if (m.shift && !m.alt && dir) return {handled: true, steps: [{command: 'table.extendCells', params: {dr: dir[0], dc: dir[1]}}]};
    if (k === 'backspace' || k === 'delete') return {handled: true, steps: [{command: 'table.clearCells', params: {}}]};
    if (k === 'enter' || k === 'return' || k === 'f2') return {handled: true, steps: [{command: 'text.edit', params: {id: cells.shape, cell: cells.from}}]};
  }
  if (!editing && hasShapes && !m.cmd) {
    const step = m.alt ? 1 : 6;
    const d = {left: [-step, 0], right: [step, 0], up: [0, -step], down: [0, step]}[k];
    if (d) return {handled: true, steps: [{command: 'shape.move', params: {dx: d[0], dy: d[1]}}]};
    if (k === 'backspace' || k === 'delete') return {handled: true, steps: [{command: 'edit.delete', params: {}}]};
    if (k === 'enter' || k === 'return' || k === 'f2') return {handled: true, steps: [{command: 'text.edit', params: {}}]};
    if (k === 'escape' || k === 'esc') return {handled: true, steps: [{command: 'edit.deselect', params: {}}]};
    if (k === 'tab') return {handled: true, select: cycleSelection(content, selection, !m.shift)};
  }
  if (!editing && !hasShapes && !m.cmd) {
    const id = {pagedown: 'slide.next', down: 'slide.next', right: 'slide.next', pageup: 'slide.previous', up: 'slide.previous', left: 'slide.previous',
      home: 'slide.first', end: 'slide.last', enter: 'slide.new', return: 'slide.new'}[k];
    if (k === 'tab') return {handled: true, select: cycleSelection(content, selection, !m.shift) ?? selectSlides([st.slideId])};
    if (id) return {handled: true, steps: [{command: id, params: {}}]};
  }
  // Shortcuts from the registry: the shell's KeyRouter.
  return {handled: false};
}

function paraStart(body, flat) {
  if (!body) return true;
  let n = 0;
  for (const p of body.paragraphs ?? []) {
    const len = (p.runs ?? []).reduce((s, r) => s + (r.kind?.kind === 'break' ? 1 : (r.text ?? '').length), 0);
    if (flat === n) return true;
    if (flat <= n + len) return false;
    n += len + 1;
  }
  return flat === n;
}

/**
 * Type text (deckcraft `type_text` / `commit_text`): into the text being edited, or, with one shape
 * selected, start editing it with everything selected (typing replaces its text, as PowerPoint
 * does). Returns the steps, or null when there is nowhere to type.
 */
export function planTyping(content, selection, text, {commit = false} = {}) {
  const st = state(content, selection);
  const insert = {command: commit ? 'text.commit' : 'text.insert', params: {text}};
  if (st.text) return [insert];
  if (st.shapes.length !== 1 || !text) return null;
  // A table: typing goes into the first selected cell (the first cell without a range).
  const cells = cellSelection(content, selection);
  const isTable = findShape(st.slide?.shapes, st.shapes[0])?.kind?.type === 'table';
  const params = cells ? {id: cells.shape, cell: cells.from} : isTable ? {id: st.shapes[0], cell: [0, 0]} : {id: st.shapes[0]};
  return [{command: 'text.edit', params}, {command: 'text.selectAll', params: {}}, insert];
}
