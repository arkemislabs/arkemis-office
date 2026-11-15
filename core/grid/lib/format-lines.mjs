// The rows or columns a size, visibility or structure command works on (U:grid/format, imported by
// U:grid/sheet). Translated from gridcraft crates/engine/src/cmd/format/sizes.rs (`line_targets`)
// and crates/engine/src/cmd.rs (`parse_lines`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The lines are the `rows`/`cols` param ("2:5", "B:B,D:F", optionally `Sheet!`- or
// `/sh:<id>/`-prefixed per part, section 14.3 `rows:2-5`, `col:F`), else the selection's; the
// sheet is `sheet`, else the prefix, else the active one. The selection belongs to the active
// sheet, so another sheet needs explicit lines. No DOM, no Node built-ins.

import {splitRef, parseArea, gridSel, targetSheet, bad} from './edit-targets.mjs';

/** Parses a lines param into {sheet: index|null, spans: [first, last][]} (0-based, inclusive). */
export function parseLines(content, text, rows, key) {
  let sheet = null;
  const spans = [];
  for (const part0 of String(text).split(',')) {
    const part = part0.trim();
    if (!part) continue;
    const split = splitRef(content, part);
    if (split.sheet !== null) {
      if (sheet !== null && sheet !== split.sheet) throw bad(key, `\`${text}\` names more than one sheet`);
      sheet = split.sheet;
    }
    const r = parseArea(split.body);
    if (!r) throw bad(key, `not a range: ${part}`);
    spans.push(rows ? [r.start.row, r.end.row] : [r.start.col, r.end.col]);
  }
  if (!spans.length) throw bad(key, `not a range: ${text}`);
  return {sheet, spans};
}

/**
 * sizes.rs `line_targets`: {sheet, lines: [first, last][]}. `keys` are the params read in order
 * (`rows` or `cols`, and for the sheet family also `range`).
 */
export function lineTargets(ctx, p, rows, keys = [rows ? 'rows' : 'cols']) {
  const key = keys.find(k => typeof p?.[k] === 'string' && p[k] !== '');
  let sheet = targetSheet(ctx, {sheet: p?.sheet}, []);
  if (key) {
    const {sheet: named, spans} = parseLines(ctx.doc, p[key], rows, key);
    if (named !== null) {
      if (p.sheet !== undefined && p.sheet !== null && named !== sheet) throw bad(key, `\`${p[key]}\` names a sheet other than \`sheet\``);
      sheet = named;
    }
    return {sheet, lines: spans.map(([a, b]) => [Math.min(a, b), Math.max(a, b)])};
  }
  const sel = gridSel(ctx);
  if (sheet !== sel.sheet) throw bad(keys[0], `missing \`${keys[0]}\`: the selection is on the active sheet`);
  return {sheet, lines: sel.ranges.map(r => (rows ? [r.start.row, r.end.row] : [r.start.col, r.end.col]))};
}
