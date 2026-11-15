// Review tab: protection (Protect Sheet, Unprotect Sheet, Protect Workbook, Allow Edit Ranges) with Excel's
// password hashes, Workbook Statistics, Check Accessibility, comment navigation (Previous and Next Comment, Previous
// and Next Note), the Comments pane flag, Show All Notes and Convert to Comments.
//
// Translated from gridcraft crates/engine/src/cmd/review.rs (`protect_sheet`, `unprotect_sheet`,
// `protect_workbook`, `allow_edit_ranges`, `stats`, `accessibility`, `step_comment`, `convert_notes`,
// `new_password_hash`) at fb1e59f. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Protection really blocks edits: a locked cell on a protected sheet refuses writes (commands/edit/cell.mjs
// `lockedCellError`, which also honours Allow Edit Ranges), formats, row and column inserts and deletes, sort and
// filter refuse by their flags, and a protected workbook structure refuses sheet adds, moves, renames, hides and
// deletes (commands/sheet/tabs.mjs). Passwords are hashed as Excel does (SHA-512, 100,000 spins); the command
// parameters are secrets, so no journal or log ever holds one.
//
// Where ours differs: the Comments pane flag and Show All Notes are the window's view state (the kernel keeps one
// view per document), and a second Protect Sheet on a password-protected sheet is refused as gridcraft refuses it.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {hasDoc, gridSel, targetSheet, targetRanges, requireSchema2, setGridSelection, selectionAt} from '../lib/edit-targets.mjs';
import {setIn, deleteIn} from '../lib/edit-parts.mjs';
import {bad, failed, baseDoc} from '../lib/data-common.mjs';
import {rangeA1, a1, parseCell} from '../lib/addr.mjs';
import {usedBounds, forEachCell, hasContent} from '../model/store.mjs';
import {newPasswordHashAsync, verifyPasswordAsync, hasPassword} from '../lib/password.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: 'fb1e59f', files: ['crates/engine/src/cmd/review.rs', 'crates/ui-egui/src/ribbon/review.rs', 'crates/ui-egui/src/dialogs.rs']};
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const PASSWORD = s.optional(s.secret({max: 255}));
const FLAG = s.optional(s.boolean());
const WRONG = 'The password you supplied is not correct.';

const target = (ctx, p) => {
  const content = baseDoc(ctx);
  const si = p?.sheet !== undefined ? targetSheet(ctx, p) : gridSel(ctx).sheet;
  requireSchema2(ctx, si);
  return {content, si, sheet: content.sheets[si]};
};
/** Checks a password against a stored hash; an unsupported or damaged hash is an error, never a match. */
async function check(stored, password) {
  let ok;
  try { ok = await verifyPasswordAsync(stored, password); } catch (e) { throw failed(e.message); }
  if (!ok) throw failed(WRONG);
}

// ---------------------------------------------------------------- protect sheet

const PROTECT_FLAGS = ['formatCells', 'formatColumns', 'formatRows', 'insertColumns', 'insertRows', 'insertHyperlinks', 'deleteColumns', 'deleteRows', 'sort', 'autofilter', 'pivotTables', 'objects', 'scenarios'];

/**
 * Excel asks for the password twice: with `askConfirm` (what the dialog sends) a password is first confirmed in the Confirm Password
 * dialog, which sends the command again with `confirmPassword`; a `confirmPassword` that differs is refused.
 */
function confirmed(ctx, command, p) {
  if (typeof p.password !== 'string' || !p.password) return true;
  if (p.confirmPassword !== undefined) {
    if (p.confirmPassword !== p.password) throw failed('Confirmation password is not identical to the password.');
    return true;
  }
  if (p.askConfirm !== true) return true;
  const {password, askConfirm, ...rest} = p;
  ctx.setView({dialogRequest: {seq: (ctx.view?.dialogRequest?.seq ?? 0) + 1, id: 'dialog.confirmPassword', init: {command, params: rest, expected: password, confirm: ''}}});
  return false;
}

/** Review > Protect Sheet: what the sheet allows is `formatCells`, `insertRows` and the like (all off by default), selecting locked and unlocked cells is on by default. */
async function protectSheet(ctx, p) {
  const {si, sheet} = target(ctx, p);
  const cur = sheet.protection && sheet.protection.enabled !== false ? sheet.protection : null;
  if (!confirmed(ctx, 'review.protectSheet', p)) return null;
  // Protecting again would replace a password without knowing it: unprotect first, as in Excel.
  if (cur && hasPassword(cur.password)) throw failed('The sheet is protected with a password. Unprotect it first (Review > Unprotect Sheet).');
  const prot = {enabled: true};
  prot.selectLocked = typeof p.selectLockedCells === 'boolean' ? p.selectLockedCells : cur ? cur.selectLocked !== false : true;
  prot.selectUnlocked = typeof p.selectUnlockedCells === 'boolean' ? p.selectUnlockedCells : cur ? cur.selectUnlocked !== false : true;
  for (const k of PROTECT_FLAGS) prot[k] = p[k] === true;
  if (typeof p.password === 'string' && p.password) prot.password = await newPasswordHashAsync(p.password, sheet.name);
  setIn(ctx.change, ['sheets', si, 'protection'], prot);
  return null;
}

async function unprotectSheet(ctx, p) {
  const {si, sheet} = target(ctx, p);
  const cur = sheet.protection && sheet.protection.enabled !== false ? sheet.protection : null;
  if (cur && hasPassword(cur.password)) await check(cur.password, p.password ?? '');
  deleteIn(ctx.change, ['sheets', si, 'protection']);
  return null;
}

// ---------------------------------------------------------------- protect workbook

/** Review > Protect Workbook: locks the structure (sheets cannot be added, moved, renamed, hidden or deleted), with an optional password unprotecting must match. */
async function protectWorkbook(ctx, p) {
  const content = baseDoc(ctx);
  const cur = !!content.protection?.structure;
  const on = typeof p.on === 'boolean' ? p.on : !cur;
  if (on === cur) return {on};
  if (on && !confirmed(ctx, 'review.protectWorkbook', p)) return {on: cur};
  if (on) {
    const prot = {structure: true};
    if (typeof p.password === 'string' && p.password) prot.password = await newPasswordHashAsync(p.password, 'workbook');
    setIn(ctx.change, ['protection'], prot);
  } else {
    if (hasPassword(content.protection.password)) await check(content.protection.password, p.password ?? '');
    deleteIn(ctx.change, ['protection']);
  }
  return {on};
}

// ---------------------------------------------------------------- allow edit ranges

const rangesOf = r => (Array.isArray(r.ranges) ? r.ranges : r.range ? [r.range] : []).filter(x => typeof x === 'string');
const unlockedNow = (ctx, sheet, r) => !r.password || (ctx.view?.unlockedRanges ?? []).some(u => u.sheet === sheet.id && u.title === r.title);
const listOf = (ctx, sheet) => (sheet.editRanges ?? []).map(r => ({title: r.title, range: rangesOf(r).join(','), password: !!r.password, unlocked: unlockedNow(ctx, sheet, r)}));

/** Review > Allow Edit Ranges: list, add, modify or delete the ranges that stay editable on a protected sheet, or unlock a password range for this session. */
async function allowEditRanges(ctx, p) {
  const {si, sheet} = target(ctx, p);
  const action = p.action ?? 'list';
  const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : null;
  const ranges = sheet.editRanges ?? [];
  const find = t => {
    if (!t) throw bad('review.allowEditRanges', 'missing `title`');
    const i = ranges.findIndex(r => r.title.toLowerCase() === t.toLowerCase());
    if (i < 0) throw bad('review.allowEditRanges', `no range titled \`${t}\``);
    return i;
  };
  const protectedNow = !!sheet.protection && sheet.protection.enabled !== false;
  if (['add', 'modify', 'delete'].includes(action) && protectedNow) throw failed('Unprotect the sheet to change its edit ranges.');
  const write = next => { if (next.length) setIn(ctx.change, ['sheets', si, 'editRanges'], next); else deleteIn(ctx.change, ['sheets', si, 'editRanges']); };
  const areasText = () => targetRanges(ctx, {...p, sheet: si}, ['range']).areas.map(rangeA1);
  // Hashed before the switch, in slices: the window keeps drawing while a range password is made.
  const hashed = ['add', 'modify'].includes(action) && typeof p.password === 'string' && p.password ? await newPasswordHashAsync(p.password, sheet.name + '/' + (title ?? '')) : null;
  const password = pw => (pw ? hashed : null);
  switch (action) {
    case 'list': break;
    case 'unlock': {
      const r = ranges[find(title)];
      if (r.password) {
        await check(r.password, p.password ?? '');
        const un = ctx.view?.unlockedRanges ?? [];
        if (!un.some(u => u.sheet === sheet.id && u.title === r.title)) ctx.setView({unlockedRanges: [...un, {sheet: sheet.id, title: r.title}]});
      }
      break;
    }
    case 'add': {
      let t = title;
      if (!t) for (let n = 1; ; n++) { t = `Range${n}`; if (!ranges.some(r => r.title.toLowerCase() === t.toLowerCase())) break; }
      if (ranges.some(r => r.title.toLowerCase() === t.toLowerCase())) throw bad('review.allowEditRanges', `a range titled \`${t}\` already exists`);
      const entry = {title: t, ranges: areasText()};
      const pw = password(p.password, t);
      if (pw) entry.password = pw;
      write([...ranges, entry]);
      break;
    }
    case 'modify': {
      const i = find(title);
      const r = {...ranges[i]};
      const n = typeof p.newTitle === 'string' ? p.newTitle.trim() : '';
      if (n) {
        if (ranges.some((x, j) => j !== i && x.title.toLowerCase() === n.toLowerCase())) throw bad('review.allowEditRanges', `a range titled \`${n}\` already exists`);
        r.title = n;
      }
      if (typeof p.password === 'string') { if (p.password) r.password = password(p.password, r.title); else delete r.password; }
      if (p.range !== undefined) { r.ranges = areasText(); delete r.range; }
      write(ranges.map((x, j) => (j === i ? r : x)));
      break;
    }
    case 'delete': {
      const i = find(title);
      write(ranges.filter((_, j) => j !== i));
      break;
    }
    default: throw bad('review.allowEditRanges', `unknown action \`${action}\``);
  }
  // The list after the change, as the transaction holds it.
  const now = ctx.change.get(['sheets', si, 'editRanges']);
  return listOf(ctx, {...sheet, editRanges: now ?? []});
}

// ---------------------------------------------------------------- statistics and accessibility

/** Workbook Statistics: counts for the active sheet and for the workbook. */
function statistics(ctx) {
  const content = baseDoc(ctx);
  const si = gridSel(ctx).sheet;
  const count = sheet => {
    let cells = 0, formulas = 0;
    forEachCell(sheet, 0, 0, 1_048_575, 16_383, (row, col, cell) => { if (hasContent(cell)) cells += 1; if (cell?.f !== undefined) formulas += 1; });
    return {cells, formulas};
  };
  const one = content.sheets[si];
  const c = count(one);
  const u = usedBounds(one);
  const totals = content.sheets.reduce((t, sh) => { const k = count(sh); return {cells: t.cells + k.cells, tables: t.tables + (sh.tables?.length ?? 0), charts: t.charts + (sh.charts?.length ?? 0)}; }, {cells: 0, tables: 0, charts: 0});
  return {
    sheet: {name: one.name, endOfSheet: u ? a1(u.r1, u.c1) : null, cellsWithData: c.cells, tables: one.tables?.length ?? 0, formulas: c.formulas, charts: one.charts?.length ?? 0,
      comments: Object.keys(one.comments ?? {}).length + Object.keys(one.notes ?? {}).length},
    workbook: {sheets: content.sheets.length, cellsWithData: totals.cells, tables: totals.tables, charts: totals.charts, names: (content.names ?? []).length},
  };
}

/** Check Accessibility: pictures without alternative text, merged cells, sheets still named Sheet. */
function accessibility(ctx) {
  const issues = [];
  for (const sh of baseDoc(ctx).sheets) {
    for (const im of sh.images ?? []) if (!im.alt) issues.push({sheet: sh.name, issue: 'Missing alternative text', object: `Picture ${im.id}`});
    if (sh.merges?.length) issues.push({sheet: sh.name, issue: 'Merged cells', count: sh.merges.length});
    if (sh.name.startsWith('Sheet')) issues.push({sheet: sh.name, issue: 'Default sheet name'});
  }
  return issues;
}

// ---------------------------------------------------------------- comments and notes

/** The comments (or notes) of the visible sheets in navigation order: tab order, then row by row. */
function commentCells(content, notes) {
  const out = [];
  content.sheets.forEach((sh, si) => {
    if (sh.hidden) return;
    const cells = Object.keys(sh[notes ? 'notes' : 'comments'] ?? {}).map(parseCell).filter(Boolean).sort((a, b) => a.row - b.row || a.col - b.col);
    for (const c of cells) out.push({si, row: c.row, col: c.col});
  });
  return out;
}
const cmp = (a, b) => a.si - b.si || a.row - b.row || a.col - b.col;

/** Selects the next (or previous) comment after the active cell, moving on to the next sheet and wrapping at the end of the workbook. */
function stepComment(ctx, forward, notes) {
  const content = baseDoc(ctx);
  const list = commentCells(content, notes);
  const sel = gridSel(ctx);
  const here = {si: sel.sheet, row: sel.active.row, col: sel.active.col};
  const hit = forward ? list.find(c => cmp(c, here) > 0) ?? list[0] : [...list].reverse().find(c => cmp(c, here) < 0) ?? list[list.length - 1];
  if (!hit) throw failed(`There are no ${notes ? 'notes' : 'comments'} in this workbook.`);
  setGridSelection(ctx, selectionAt(hit.si, {row: hit.row, col: hit.col}));
  return {sheet: content.sheets[hit.si].name, cell: a1(hit.row, hit.col)};
}
const navState = notes => ctx => {
  if (!hasDoc(ctx).enabled) return hasDoc(ctx);
  return commentCells(ctx.doc, notes).length ? {enabled: true} : {enabled: false, reason: `there are no ${notes ? 'notes' : 'comments'} in this workbook`};
};

/** Review > Notes > Convert to Comments: every note in the workbook becomes a comment with the same author and text. */
function convertNotes(ctx) {
  const content = baseDoc(ctx);
  let converted = 0;
  content.sheets.forEach((sh, si) => {
    const notes = sh.notes ?? {};
    const keys = Object.keys(notes).filter(k => !(sh.comments ?? {})[k]);
    if (!keys.length) return;
    const comments = {...(sh.comments ?? {})};
    const rest = {...notes};
    for (const k of keys) {
      const n = notes[k];
      comments[k] = {author: n.author ?? '', text: n.text ?? '', replies: [], threaded: true, resolved: false, visible: false};
      delete rest[k];
      converted += 1;
    }
    setIn(ctx.change, ['sheets', si, 'comments'], comments);
    if (Object.keys(rest).length) setIn(ctx.change, ['sheets', si, 'notes'], rest); else deleteIn(ctx.change, ['sheets', si, 'notes']);
  });
  return {converted};
}

const withNotes = s.object({notes: FLAG});

export default defineCommands({
  family: 'review',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {id: 'review.protectSheet', label: 'Protect Sheet', risk: 'edit', dialog: 'dialog.protectSheet', journal: false,
      description: 'Protect a sheet: locked cells refuse edits. `password` is optional; what the sheet still allows is selectLockedCells and selectUnlockedCells (on by default), formatCells, formatColumns, formatRows, insertColumns, insertRows, deleteColumns, deleteRows, sort, autofilter, insertHyperlinks, pivotTables, objects (Edit objects) and scenarios (off by default). A sheet with a password must be unprotected first.',
      params: s.object({sheet: SHEET, password: PASSWORD, confirmPassword: PASSWORD, askConfirm: FLAG, selectLockedCells: FLAG, selectUnlockedCells: FLAG, formatCells: FLAG, formatColumns: FLAG, formatRows: FLAG, insertColumns: FLAG, insertRows: FLAG, insertHyperlinks: FLAG, deleteColumns: FLAG, deleteRows: FLAG, sort: FLAG, autofilter: FLAG, pivotTables: FLAG, objects: FLAG, scenarios: FLAG}),
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: !!ctx.doc.sheets[gridSel(ctx).sheet]?.protection && ctx.doc.sheets[gridSel(ctx).sheet].protection.enabled !== false} : hasDoc(ctx)), run: protectSheet},
    {id: 'review.unprotectSheet', label: 'Unprotect Sheet', risk: 'edit', dialog: 'dialog.unprotectSheet', journal: false,
      description: 'Unprotect a sheet; with a password set, `password` must match.', params: s.object({sheet: SHEET, password: PASSWORD}), state: hasDoc, run: unprotectSheet},
    {id: 'review.protectWorkbook', label: 'Protect Workbook', risk: 'edit', dialog: 'dialog.protectWorkbook', journal: false,
      description: 'Lock or unlock the workbook structure (`on`, default: toggle); sheets cannot be added, moved, renamed, hidden or deleted while it is locked. Unprotecting needs the password when one was set.',
      params: s.object({on: FLAG, password: PASSWORD, confirmPassword: PASSWORD, askConfirm: FLAG}),
      state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: !!ctx.doc.protection?.structure} : hasDoc(ctx)), run: protectWorkbook},
    {id: 'review.allowEditRanges', label: 'Allow Edit Ranges', risk: 'edit', dialog: 'dialog.allowEditRanges', journal: false,
      description: 'The ranges that stay editable on a protected sheet: `action` list (default), add, modify, delete or unlock (with the range password, for this session); `title`, `range` (default the selection), `password`, `newTitle`. Returns the ranges.',
      params: s.object({sheet: SHEET, action: s.optional(s.enum(['list', 'add', 'modify', 'delete', 'unlock'])), title: s.optional(s.string({max: 255})), range: s.optional(s.string({max: 4096})), password: PASSWORD, newTitle: s.optional(s.string({max: 255}))}),
      state: hasDoc, run: allowEditRanges},
    {id: 'review.workbookStatistics', label: 'Workbook Statistics', risk: 'read', dialog: 'dialog.statistics',
      description: 'Counts for the active sheet (end of sheet, cells with data, tables, formulas, charts, comments) and the workbook (sheets, cells, tables, charts, names).', params: s.object({}), state: hasDoc, run: statistics},
    {id: 'review.checkAccessibility', label: 'Check Accessibility', risk: 'read', dialog: 'dialog.accessibility',
      description: 'The accessibility issues of the workbook: pictures without alternative text, merged cells, sheets still named Sheet.', params: s.object({}), state: hasDoc, run: accessibility},
    {id: 'review.previousComment', label: 'Previous Comment', risk: 'read', effect: 'view', description: 'Select the previous comment (or, with `notes`, note) in reading order, across sheets, wrapping.',
      params: withNotes, state: (ctx, p) => navState(p?.notes === true)(ctx), run: (ctx, p) => stepComment(ctx, false, p.notes === true)},
    {id: 'review.nextComment', label: 'Next Comment', risk: 'read', effect: 'view', description: 'Select the next comment (or, with `notes`, note) in reading order, across sheets, wrapping.',
      params: withNotes, state: (ctx, p) => navState(p?.notes === true)(ctx), run: (ctx, p) => stepComment(ctx, true, p.notes === true)},
    {id: 'review.showComments', label: 'Show Comments', risk: 'read', effect: 'view', description: 'Show or hide the Comments pane (`on`, default: toggle).',
      params: s.object({on: FLAG}), state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: !!ctx.view?.commentsPane} : hasDoc(ctx)),
      run: (ctx, p) => { const on = typeof p.on === 'boolean' ? p.on : !ctx.view?.commentsPane; ctx.setView({commentsPane: on}); return {on}; }},
    {id: 'review.showAllNotes', label: 'Show All Notes', risk: 'read', effect: 'view', description: 'Show every note on the sheets, or hide them again (`on`, default: toggle).',
      params: s.object({on: FLAG}), state: ctx => (hasDoc(ctx).enabled ? {enabled: true, checked: !!ctx.view?.showAllNotes} : hasDoc(ctx)),
      run: (ctx, p) => { const on = typeof p.on === 'boolean' ? p.on : !ctx.view?.showAllNotes; ctx.setView({showAllNotes: on}); return {on}; }},
    {id: 'review.convertToComments', label: 'Convert to Comments', risk: 'edit', description: 'Turn every note in the workbook into a comment with the same author and text.',
      params: s.object({}), state: hasDoc, run: convertNotes},
  ],
});

export {statistics, accessibility, listOf as editRangeList};
