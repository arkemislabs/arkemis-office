// Insert > Links, Comments and Symbols, and the checkbox cell control: Insert Link (Ctrl+K) with its
// hyperlink and Open Hyperlink, notes and threaded comments (New, Reply, Resolve, Delete, Show/Hide),
// Symbol, and Insert Checkbox.
// Translated from gridcraft crates/engine/src/cmd/insert/links.rs (`insert_link`, `open_link`,
// `comment`, `reply_comment`, `resolve_comment`, `delete_comment`, `show_note`, `links_outside`),
// cmd/insert.rs (`insert_symbol`) and cmd/extra/cells.rs (`checkbox`, `toggle_checkbox`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Stored on the sheet: hyperlinks {A1: {target|location, tooltip?}} (target = outside the workbook,
// location = a place in it), notes {A1: {text, author, visible?}}, comments {A1: {author, text,
// replies: [[author, text]], threaded: true, resolved, visible}}. A cell holds a note or a comment.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {a1, parseCell, contains, iterRange} from '../../lib/addr.mjs';
import {hasDoc, gridSel, targetSheet, targetRanges, cellParamOn, requireSchema2, setGridSelection, rangeSelection} from '../../lib/edit-targets.mjs';
import {setIn, deleteIn} from '../../lib/edit-parts.mjs';
import {bad, baseDoc, failed} from '../../lib/data-common.mjs';
import {cellAt, writeCell} from '../../model/store.mjs';
import {deriveStyle, resolveStyle, styleById} from '../../model/style.mjs';
import {enterInput} from '../../model/input.mjs';
import {classify, linkIsOutside} from '../../lib/links.mjs';
import {rangeCell} from '../../lib/addr.mjs';
import {lockedCellError} from '../edit/cell.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/insert.rs', 'crates/engine/src/cmd/insert/links.rs', 'crates/engine/src/cmd/extra/cells.rs']};
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const CELL = s.optional(s.string({min: 1, max: 600}));
const AUTHOR = 'You';

/** The Symbol gallery: gridcraft's thirty (crates/ui-egui/src/ribbon/insert.rs). */
const SYMBOLS = [...'€£¥©®™±≠≤≥÷×∞µαβπΣΩ°•…→←↑↓✓★½¼'];
const symbolTiles = SYMBOLS.map(c => ({id: c, label: `Insert ${c}`, value: c, sample: c}));
const symbolState = ctx => ({...hasDoc(ctx), value: symbolTiles});

let seq = 0;
const nextSeq = () => ++seq;

function insertLink(ctx, p) {
  const content = baseDoc(ctx);
  const si = targetSheet(ctx, p, ['cell']);
  requireSchema2(ctx, si);
  const at = cellParamOn(ctx, p, 'cell', si) ?? gridSel(ctx).active;
  const key = a1(at.row, at.col);
  // On a protected sheet a hyperlink in a locked cell needs Insert hyperlinks to be allowed.
  { const locked = lockedCellError(ctx, si, at.row, at.col); if (locked && !ctx.doc.sheets[si].protection?.insertHyperlinks) throw failed(locked); }
  if (p.remove === true) { deleteIn(ctx.change, ['sheets', si, 'hyperlinks', key]); return null; }
  if (typeof p.target !== 'string' || !p.target.trim()) {
    ctx.setView({dialogRequest: {seq: nextSeq(), id: 'dialog.insertLink', init: {}}});
    return null;
  }
  const sheet = content.sheets[si];
  const target = p.target.trim();
  const outside = linkIsOutside(content, target);
  const old = cellAt(sheet, at.row, at.col);
  // The cell shows the link as one: hyperlink colour and an underline.
  const styleId = deriveStyle(ctx.change, content, old?.s ?? 0, {font: {color: {theme: 10, tint: 0}, underline: 'single'}});
  const text = typeof p.text === 'string' ? p.text : old && (old.v === undefined || old.v === null) && old.f === undefined ? target : (!old ? target : null);
  if (text !== null) writeCell(ctx.change, content, si, at.row, at.col, {...(old ?? {}), v: text, f: undefined, s: styleId});
  else writeCell(ctx.change, content, si, at.row, at.col, {...old, s: styleId});
  const link = outside ? {target} : {location: target.replace(/^#/, '')};
  if (typeof p.tooltip === 'string' && p.tooltip) link.tooltip = p.tooltip;
  setIn(ctx.change, ['sheets', si, 'hyperlinks', key], link);
  return null;
}

function openLink(ctx, p) {
  const content = baseDoc(ctx);
  let target = typeof p.url === 'string' && p.url ? p.url : typeof p.target === 'string' && p.target ? p.target : null;
  if (target === null) {
    const si = targetSheet(ctx, p, ['cell']);
    const at = cellParamOn(ctx, p, 'cell', si) ?? gridSel(ctx).active;
    const h = content.sheets[si].hyperlinks?.[a1(at.row, at.col)];
    if (!h) throw failed("There's no hyperlink in this cell.");
    target = h.target ?? h.location ?? '';
  }
  const kind = classify(target);
  if (kind.kind === 'internal') { ctx.run('edit.goTo', {reference: kind.target.replace(/^#/, '')}); return {opened: kind.target}; }
  if (kind.kind === 'external') { ctx.setView({openUrlRequest: {seq: nextSeq(), url: kind.target}}); return {opened: kind.target}; }
  throw failed(kind.reason);
}

// ---------------------------------------------------------------- notes and comments

const noteAt = (sheet, key) => sheet.notes?.[key] ?? null;
const commentAt = (sheet, key) => sheet.comments?.[key] ?? null;

function comment(ctx, p, threaded) {
  const content = baseDoc(ctx);
  const si = targetSheet(ctx, p, ['cell']);
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  const at = cellParamOn(ctx, p, 'cell', si) ?? gridSel(ctx).active;
  const key = a1(at.row, at.col);
  const text = typeof p.text === 'string' ? p.text : '';
  const named = typeof p.author === 'string' && p.author ? p.author : null;
  const author = named ?? ctx.host?.userName ?? AUTHOR;
  // Writing a note on a cell that has one edits it, as Excel's Edit Note does: the box, the replies, the dates and who wrote
  // it stay. A note replaces a comment and vice versa.
  const existing = threaded ? commentAt(sheet, key) : noteAt(sheet, key);
  if (existing) {
    const next = {...existing, text};
    if (named) next.author = named;
    setIn(ctx.change, ['sheets', si, threaded ? 'comments' : 'notes', key], next);
    return {cell: key};
  }
  deleteIn(ctx.change, ['sheets', si, threaded ? 'notes' : 'comments', key]);
  setIn(ctx.change, ['sheets', si, threaded ? 'comments' : 'notes', key], threaded
    ? {author, text, replies: [], threaded: true, resolved: false, visible: false}
    : {text, author});
  return {cell: key};
}

function replyComment(ctx, p) {
  const content = baseDoc(ctx);
  const si = targetSheet(ctx, p, ['cell']);
  const at = cellParamOn(ctx, p, 'cell', si) ?? gridSel(ctx).active;
  const key = a1(at.row, at.col);
  const c = commentAt(content.sheets[si], key);
  if (!c) throw failed("There's no comment in this cell.");
  const author = typeof p.author === 'string' && p.author ? p.author : ctx.host?.userName ?? AUTHOR;
  ctx.change.set(['sheets', si, 'comments', key], {...c, replies: [...(c.replies ?? []), [author, p.text ?? '']]});
  return null;
}

function resolveComment(ctx, p) {
  const content = baseDoc(ctx);
  const si = targetSheet(ctx, p, ['cell']);
  const at = cellParamOn(ctx, p, 'cell', si) ?? gridSel(ctx).active;
  const key = a1(at.row, at.col);
  const c = commentAt(content.sheets[si], key);
  if (c) ctx.change.set(['sheets', si, 'comments', key], {...c, resolved: p.resolved !== false});
  return null;
}

function deleteComment(ctx, p) {
  const content = baseDoc(ctx);
  const {sheet: si, areas} = targetRanges(ctx, p, ['cell', 'range']);
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  for (const map of ['comments', 'notes']) {
    const cur = sheet[map];
    if (!cur) continue;
    const next = Object.fromEntries(Object.entries(cur).filter(([k]) => { const c = parseCell(k); return !(c && areas.some(r => contains(r, c))); }));
    if (Object.keys(next).length !== Object.keys(cur).length) ctx.change.set(['sheets', si, map], next);
  }
  return null;
}

function showNote(ctx, p) {
  const content = baseDoc(ctx);
  const si = targetSheet(ctx, p, ['cell']);
  const at = cellParamOn(ctx, p, 'cell', si) ?? gridSel(ctx).active;
  const key = a1(at.row, at.col);
  const sheet = content.sheets[si];
  for (const map of ['comments', 'notes']) {
    const c = sheet[map]?.[key];
    if (c) { ctx.change.set(['sheets', si, map, key], {...c, visible: !c.visible}); break; }
  }
  return null;
}

// ---------------------------------------------------------------- symbol and checkbox

function insertSymbol(ctx, p) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  const si = sel.sheet;
  requireSchema2(ctx, si);
  const at = sel.active;
  const old = cellAt(content.sheets[si], at.row, at.col);
  const cur = old?.f !== undefined ? `=${old.f}` : old && typeof old.v === 'string' ? old.v : old && old.v !== undefined && old.v !== null ? String(old.v) : '';
  enterInput(ctx.change, content, si, at.row, at.col, `${cur}${p.char ?? ''}`);
  return null;
}

const numFmtOf = (content, id) => resolveStyle(styleById(content, id ?? 0)).numFmt;

function insertCheckbox(ctx, p) {
  const content = baseDoc(ctx);
  const {sheet: si, areas} = targetRanges(ctx, p);
  requireSchema2(ctx, si);
  for (const r of areas) {
    if ((r.end.row - r.start.row + 1) * (r.end.col - r.start.col + 1) > 100_000) throw bad('insert.checkbox', 'range too large');
    for (const at of iterRange(r)) {
      const old = cellAt(content.sheets[si], at.row, at.col);
      const styleId = deriveStyle(ctx.change, content, old?.s ?? 0, {numFmt: 'checkbox', align: {h: 'center'}});
      // Values and formulas already there stay (only TRUE/FALSE draw as a box); an empty cell starts unchecked.
      const cell = {...(old ?? {}), s: styleId};
      if ((cell.v === undefined || cell.v === null) && cell.f === undefined) cell.v = false;
      writeCell(ctx.change, content, si, at.row, at.col, cell);
    }
  }
  return null;
}

function toggleCheckbox(ctx, p) {
  const content = baseDoc(ctx);
  const sel = gridSel(ctx);
  const si = p.sheet !== undefined ? targetSheet(ctx, p) : sel.sheet;
  requireSchema2(ctx, si);
  const one = cellParamOn(ctx, p, 'cell', si);
  const cells = one ? [one] : sel.ranges.flatMap(r => [...iterRange(r)].slice(0, 100_000));
  for (const at of cells) {
    const cell = cellAt(content.sheets[si], at.row, at.col);
    if (!cell || cell.f !== undefined || numFmtOf(content, cell.s) !== 'checkbox') continue;
    // An empty checkbox cell counts as FALSE.
    const next = typeof cell.v === 'boolean' ? !cell.v : cell.v === undefined || cell.v === null ? true : undefined;
    if (next === undefined) continue;
    writeCell(ctx.change, content, si, at.row, at.col, {...cell, v: next});
  }
  return null;
}

export default defineCommands({
  family: 'insert/links',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'insert.link', label: 'Link', risk: 'edit', dialog: 'dialog.insertLink',
      description: 'Insert (or with remove: true delete) a hyperlink on a cell: target a web address, file, mail address or a place in the workbook (Sheet2!A1, a name), text (what the cell shows), tooltip. With no target it opens the Insert Hyperlink dialog.',
      params: s.object({cell: CELL, sheet: SHEET, target: s.optional(s.string({max: 2083})), text: s.optional(s.string({max: 32_767})), tooltip: s.optional(s.string({max: 255})), remove: s.optional(s.boolean())}),
      state: hasDoc,
      run: insertLink,
    },
    {
      id: 'link.open', label: 'Open Hyperlink', risk: 'edit', undo: 'none', effect: 'view',
      description: 'Follow a link: a place in the workbook is selected; only http, https and mailto addresses are handed to the system, any other is an error. Default: the active cell\'s link.',
      params: s.object({url: s.optional(s.string({max: 2083})), target: s.optional(s.string({max: 2083})), cell: CELL, sheet: SHEET}),
      state: hasDoc,
      run: openLink,
    },
    {
      id: 'review.newNote', label: 'New Note', risk: 'edit',
      description: 'Put a note on a cell (or edit its note): text, author.',
      params: s.object({cell: CELL, sheet: SHEET, text: s.string({max: 32_767}), author: s.optional(s.string({max: 255})), threaded: s.optional(s.boolean())}),
      state: hasDoc,
      run: (ctx, p) => comment(ctx, p, p.threaded === true),
    },
    {
      id: 'review.newComment', label: 'New Comment', risk: 'edit', dialog: 'dialog.comment',
      description: 'Start a threaded comment on a cell (or edit its comment): text, author.',
      params: s.object({cell: CELL, sheet: SHEET, text: s.string({max: 32_767}), author: s.optional(s.string({max: 255})), threaded: s.optional(s.boolean())}),
      state: hasDoc,
      run: (ctx, p) => comment(ctx, p, p.threaded !== false),
    },
    {
      id: 'review.replyComment', label: 'Reply', risk: 'edit',
      description: 'Reply in the comment thread of a cell.',
      params: s.object({cell: CELL, sheet: SHEET, text: s.optional(s.string({max: 32_767})), author: s.optional(s.string({max: 255}))}),
      state: hasDoc,
      run: replyComment,
    },
    {
      id: 'review.resolveComment', label: 'Resolve Thread', risk: 'edit',
      description: 'Resolve (or with resolved: false reopen) the comment thread of a cell.',
      params: s.object({cell: CELL, sheet: SHEET, resolved: s.optional(s.boolean())}),
      state: hasDoc,
      run: resolveComment,
    },
    {
      id: 'review.deleteComment', label: 'Delete Comment', risk: 'edit',
      description: 'Delete the notes and comments in `range` (default: the selection).',
      params: s.object({range: s.optional(s.string({min: 1, max: 4096})), cell: CELL, sheet: SHEET}),
      state: hasDoc,
      run: deleteComment,
    },
    {
      id: 'review.showNote', label: 'Show/Hide Note', risk: 'edit',
      description: 'Show or hide the note (or comment) of a cell.',
      params: s.object({cell: CELL, sheet: SHEET}),
      state: hasDoc,
      run: showNote,
    },
    {
      id: 'insert.symbol', label: 'Symbol', risk: 'edit', dialog: 'dialog.symbol',
      description: 'Insert a symbol at the end of the active cell\'s text: char (for example "€").',
      params: s.object({char: s.string({min: 1, max: 32})}),
      state: symbolState,
      run: insertSymbol,
    },
    {
      id: 'insert.checkbox', label: 'Checkbox', risk: 'edit',
      description: 'Turn the cells of `range` (default: the selection) into checkboxes; an empty cell starts unchecked.',
      params: s.object({range: s.optional(s.string({min: 1, max: 4096})), sheet: SHEET}),
      state: hasDoc,
      run: insertCheckbox,
    },
    {
      id: 'cell.toggleCheckbox', label: 'Toggle Checkbox', risk: 'edit',
      description: 'Check or uncheck the checkbox cells of the selection (or `cell`).',
      params: s.object({cell: CELL, sheet: SHEET}),
      state: hasDoc,
      run: toggleCheckbox,
    },
  ],
});

export {setGridSelection, rangeSelection, rangeCell};
