// The parts of a sheet that sit beside its cells and travel with them on clear, copy, cut and
// paste: notes and comments, hyperlinks, merged areas, data validation and conditional format
// rules, column widths (U:grid/edit; other units may import, not edit).
// Translated from the side tables of gridcraft crates/model/src/sheet.rs (`comments`,
// `hyperlinks`, `merges`, `validations`, `cond_formats`, `cols`) and
// crates/engine/src/cmd/data.rs (`remove_validation_cells`, `move_rule_formula`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Schema-2 shapes used here (design note U-grid-edit--F-grid--side-tables asks the
// foundation to document them): `notes` and `comments` map an A1 key to the note/thread,
// `hyperlinks` maps an A1 key to the link, `merges` is a list of 'A1:B2', `validations` and
// `conditionalFormats` are lists of rules each with `ranges: 'A1:B2'[]` (validation formulas in
// `f1`/`f2`, text without '='). No DOM, no Node built-ins.

import {parseRange, rangeA1, contains, containsRange, intersects, a1} from './addr.mjs';
import {parse, print, shiftRelative} from './formula.mjs';

/** Sets a value, creating missing parent objects (the change API needs the parent to exist). */
export function setIn(change, path, value) {
  for (let i = 1; i < path.length; i++) {
    const parent = path.slice(0, i);
    if (change.get(parent) === undefined) change.set(parent, {});
  }
  change.set(path, value);
}
/** Deletes a key when present. */
export function deleteIn(change, path) {
  if (change.get(path) !== undefined) change.delete(path);
}

const keyCell = k => parseRange(k)?.start ?? null;

/** Keys of an A1-keyed side map (notes, comments, hyperlinks) inside a range. */
export function keysIn(map, r) {
  if (!map) return [];
  return Object.keys(map).filter(k => { const c = keyCell(k); return c && contains(r, c); });
}

export const NOTE_MAPS = Object.freeze(['notes', 'comments']);

/** Removes the A1-keyed entries of `map` inside `r` on sheet si. Returns how many. */
export function removeKeysIn(change, content, si, map, r) {
  const m = content.sheets[si]?.[map];
  let n = 0;
  for (const k of keysIn(m, r)) { change.delete(['sheets', si, map, k]); n++; }
  return n;
}

/** A note, comment and hyperlink entry for one cell (any of them may be missing). */
export function sideEntries(sheet, row, col) {
  const k = a1(row, col);
  return {note: sheet?.notes?.[k], comment: sheet?.comments?.[k], link: sheet?.hyperlinks?.[k]};
}

/** Removes merged areas fully inside `r` (or, with `touching`, intersecting it). Returns the removed ranges. */
export function removeMerges(change, content, si, r, {touching = false} = {}) {
  const list = content.sheets[si]?.merges;
  if (!Array.isArray(list) || !list.length) return [];
  const removed = [], kept = [];
  for (const m of list) {
    const mr = parseRange(m);
    if (mr && (touching ? intersects(r, mr) : containsRange(r, mr))) removed.push(mr); else kept.push(m);
  }
  if (removed.length) change.set(['sheets', si, 'merges'], kept);
  return removed;
}
/** Adds a merged area, dropping existing ones it overlaps. */
export function addMerge(change, content, si, r) {
  const list = (change.get(['sheets', si, 'merges']) ?? []).filter(m => { const mr = parseRange(m); return !mr || !intersects(mr, r); });
  list.push(rangeA1(r));
  setIn(change, ['sheets', si, 'merges'], list);
}

const ruleRanges = rule => (Array.isArray(rule?.ranges) ? rule.ranges : rule?.range ? [rule.range] : [])
  .map(x => (typeof x === 'string' ? parseRange(x) : x)).filter(Boolean);

/** The first rule of a list (validations, conditional formats) covering a cell. */
export function ruleAt(list, c) {
  return (Array.isArray(list) ? list : []).find(rule => ruleRanges(rule).some(r => contains(r, c))) ?? null;
}

/** `r` minus the cells of `cut`: up to four rectangles. */
export function subtract(r, cut) {
  if (!intersects(r, cut)) return [r];
  const out = [];
  if (r.start.row < cut.start.row) out.push({start: {...r.start}, end: {row: cut.start.row - 1, col: r.end.col}});
  if (r.end.row > cut.end.row) out.push({start: {row: cut.end.row + 1, col: r.start.col}, end: {...r.end}});
  const top = Math.max(r.start.row, cut.start.row), bottom = Math.min(r.end.row, cut.end.row);
  if (r.start.col < cut.start.col) out.push({start: {row: top, col: r.start.col}, end: {row: bottom, col: cut.start.col - 1}});
  if (r.end.col > cut.end.col) out.push({start: {row: top, col: cut.end.col + 1}, end: {row: bottom, col: r.end.col}});
  return out;
}

/** data.rs `remove_validation_cells`: the rules lose `cells`; a rule left with no cells goes. */
export function removeRuleCells(change, si, listName, cells) {
  const list = change.get(['sheets', si, listName]);
  if (!Array.isArray(list) || !list.length) return;
  let changed = false;
  const next = [];
  for (const rule of list) {
    let rs = ruleRanges(rule);
    if (!rs.some(r => intersects(r, cells))) { next.push(rule); continue; }
    changed = true;
    rs = rs.flatMap(r => subtract(r, cells));
    if (rs.length) next.push({...rule, ranges: rs.map(rangeA1)});
  }
  if (changed) change.set(['sheets', si, listName], next);
}
/** Appends a rule to a sheet list. */
export function addRule(change, si, listName, rule) {
  const list = change.get(['sheets', si, listName]);
  setIn(change, ['sheets', si, listName], [...(Array.isArray(list) ? list : []), rule]);
}

/** data.rs `move_rule_formula`: relative references in a rule's formula move from `from` to `to`. */
export function moveRuleFormula(f, from, to) {
  if (typeof f !== 'string' || f === '') return f;
  const eq = f.startsWith('=');
  const body = eq ? f.slice(1) : f;
  let e;
  try { e = parse(body); } catch { return f; }
  const moved = print(shiftRelative(e, to.row - from.row, to.col - from.col));
  return eq ? `=${moved}` : moved;
}

export {ruleRanges};
