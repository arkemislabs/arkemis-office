// Go To references and the names the Go To dialog lists (U:grid/edit; other units may import).
// Translated from gridcraft crates/engine/src/cmd/edit/go_to.rs (`GO_TO_RECENT`,
// `GO_TO_MAX_AREAS`, `GO_TO_NAME_DEPTH`, `reference_parts`, `go_to_target`, `name_areas`,
// `go_to_names`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {parseRange, quoteSheet, unquoteSheet} from './addr.mjs';
import {foldName, sameName} from './formula.mjs';
import {sheetIndex, tableByName, tableRanges} from '../model/sheet.mjs';

/** How many references the Go To dialog keeps for going back to. */
export const GO_TO_RECENT = 10;
/** The most areas one Go To selects. */
export const GO_TO_MAX_AREAS = 2000;
/** How deep a name that refers to other names is followed. */
const GO_TO_NAME_DEPTH = 8;

/**
 * The parts of a Go To reference, split at commas outside quoted sheet names and parentheses
 * (`Price, Type`, `B14:C22,F19:G30`), read one at a time.
 */
export function* referenceParts(text) {
  let depth = 0, quoted = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") quoted = !quoted;
    else if (c === '(' && !quoted) depth++;
    else if (c === ')' && !quoted) depth = Math.max(0, depth - 1);
    else if (c === ',' && !quoted && depth === 0) { yield text.slice(start, i).trim(); start = i + 1; }
  }
  yield text.slice(start).trim();
}

/** core::split_sheet: `'Q1, Q2'!B2` → ['Q1, Q2', 'B2']. */
function splitSheet(part) {
  const i = part.lastIndexOf('!');
  return i < 0 ? [null, part] : [unquoteSheet(part.slice(0, i)), part.slice(i + 1)];
}

const scopeIndex = (content, n) => (n.scope === undefined || n.scope === null ? null : content.sheets.findIndex(sh => sh.id === n.scope));

/** Workbook::name: a name visible from sheet `si` (its own first, then the workbook's). */
function nameFrom(content, body, si) {
  const names = content.names ?? [];
  const own = content.sheets[si]?.id;
  return names.find(n => n.scope === own && sameName(n.name, body)) ?? names.find(n => (n.scope === undefined || n.scope === null) && sameName(n.name, body)) ?? null;
}

/**
 * Where one part of a reference points, seen from sheet `si`: {sheet, areas, byName}, or null.
 * `Sheet2!Name` is the name scoped to Sheet2; a name counts when it refers to a reference.
 */
export function goToTarget(content, si, part, depth = 0) {
  if (!part || depth > GO_TO_NAME_DEPTH) return null;
  const [prefix, body] = splitSheet(part);
  let on = si;
  if (prefix !== null) { on = sheetIndex(content, prefix); if (on < 0) return null; }
  const r = parseRange(body.replace(/\$/g, ''));
  if (r) return {sheet: on, areas: [r], byName: false};
  const n = prefix !== null
    ? (content.names ?? []).find(x => scopeIndex(content, x) === on && sameName(x.name, body))
    : nameFrom(content, body, si);
  if (n) { const t = nameAreas(content, n, si, depth); return t ? {...t, byName: true} : null; }
  if (prefix === null) {
    const t = tableByName(content, body);
    if (t) {
      // As in Excel, a table's name stands for its data, without the header and totals rows.
      const g = tableRanges(t[1]);
      return {sheet: t[0], areas: [g.data ?? g.range], byName: true};
    }
  }
  return null;
}

/** The sheet and areas defined name `n` refers to, seen from sheet `si`, when that is a reference. */
export function nameAreas(content, n, si, depth = 0) {
  const scope = scopeIndex(content, n);
  const from = scope === null || scope < 0 ? si : scope;
  const formula = String(n.formula ?? '').trim().replace(/^=/, '');
  let target = null;
  const areas = [];
  for (const part of referenceParts(formula)) {
    const t = goToTarget(content, from, part, depth + 1);
    if (!t) return null;
    if (target !== null && target !== t.sheet) return null;
    target = t.sheet;
    areas.push(...t.areas);
    if (areas.length > GO_TO_MAX_AREAS) return null;
  }
  return target === null ? null : {sheet: target, areas};
}

/**
 * The names the Go To dialog lists, seen from sheet `si`: the named ranges of the workbook and of
 * every sheet, alphabetical; another sheet's name is written `Sheet2!Name`, and the sheet's own
 * name hides the workbook name it shares. Hidden names and names that are not ranges are left out.
 */
export function goToNames(content, si) {
  const names = content.names ?? [];
  const ownId = content.sheets[si]?.id;
  const own = new Set(names.filter(n => n.scope === ownId).map(n => foldName(n.name)));
  const out = [];
  for (const n of names) {
    if (n.hidden || !nameAreas(content, n, si, 0)) continue;
    const scope = scopeIndex(content, n);
    if (scope === null) { if (!own.has(foldName(n.name))) out.push(n.name); }
    else if (scope === si) out.push(n.name);
    else if (scope >= 0) out.push(`${quoteSheet(content.sheets[scope].name)}!${n.name}`);
  }
  const keyed = out.map(n => [foldName(n), n]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dedup = [];
  for (const [, n] of keyed) if (!dedup.length || !sameName(dedup[dedup.length - 1], n)) dedup.push(n);
  return dedup;
}
