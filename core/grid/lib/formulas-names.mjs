// Defined names as the Formulas tab handles them: valid names, the hidden names GridCraft keeps its
// own data in, the names Paste Names lists, renaming a name inside formulas, and a value as JSON.
// Translated from gridcraft crates/engine/src/cmd/formulas.rs (`valid_name`, `is_r1c1`,
// `holds_gridcraft_data`, `refuse_stash_name`, `pasteable_names`, `rename_name_in_formulas`),
// crates/engine/src/cmd/stash.rs (`holds_item`, `item_of`, `parse_name`) and
// crates/engine/src/cmd/inspect.rs (`value_json`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Schema-2 names are `{name, formula (no leading '='), scope?: sheet id, comment?, hidden?}`;
// upstream scopes are sheet indexes. U:grid/formulas owns this file; other units may import it.
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {parseCell} from './addr.mjs';
import {parse, parseName, print, mapExpr, foldName, sameName} from './formula.mjs';
import {CellError, GArray} from './value.mjs';
import {cellAt, blockEntries} from '../model/store.mjs';
import {writeCell} from '../model/store.mjs';

export {foldName, sameName};

/** A name's definition without its leading `=`. */
export const nameBody = n => String(n?.formula ?? '').replace(/^=/, '');

/**
 * Looks like an R1C1 reference (`R`, `C`, `RC`, `R2`, `C3`, `R1C1`), which Excel doesn't accept
 * as a name (formulas.rs `is_r1c1`).
 */
export function isR1C1(n) {
  const digits = s => { let i = 0; while (i < s.length && s[i] >= '0' && s[i] <= '9') i++; return i; };
  let rest = n;
  if (rest[0] === 'R' || rest[0] === 'r') { const r = rest.slice(1); rest = r.slice(digits(r)); }
  if (rest[0] === 'C' || rest[0] === 'c') { const c = rest.slice(1); rest = c.slice(digits(c)); }
  return rest === '' && n !== '';
}

const LETTER = /\p{L}/u;
const ALNUM = /[\p{L}\p{N}]/u;
/** formulas.rs `valid_name`: Excel's rules for a defined name (255 characters, not a reference). */
export function validName(n) {
  if (typeof n !== 'string' || !n) return false;
  const chars = [...n];
  const first = chars[0];
  if (!(LETTER.test(first) || first === '_' || first === '\\')) return false;
  if (chars.length > 255 || parseCell(n) || isR1C1(n)) return false;
  return chars.every(c => ALNUM.test(c) || c === '_' || c === '.' || c === '\\' || c === '?');
}

// stash.rs: `_gc_<key>_<k>` chunks (hidden, workbook scope) and legacy `_sc_<key>` items.
const startsCi = (s, p) => s.length >= p.length && s.slice(0, p.length).toLowerCase() === p;
function stashParts(name) {
  if (startsCi(name, '_gc_')) {
    const rest = name.slice(4);
    const i = rest.lastIndexOf('_');
    if (i < 0) return null;
    const key = rest.slice(0, i), k = rest.slice(i + 1);
    const canonical = k.length > 0 && k.length <= 9 && /^[0-9]+$/.test(k) && (k === '0' || k[0] !== '0');
    if (!key || !canonical) return null;
    return {key, chunk: Number(k)};
  }
  if (startsCi(name, '_sc_')) {
    const key = name.slice(4);
    return key ? {key, chunk: null} : null;
  }
  return null;
}
const itemOf = n => {
  if (n.scope !== undefined && n.scope !== null) return null;
  const p = stashParts(n.name);
  return p && (p.chunk === null || n.hidden) ? p : null;
};
/** stash.rs `holds_item`: a hidden name the application keeps its own workbook data in (the old `_gc_` and `_sc_` names are still read). */
export const holdsAppData = (content, name) => (content.names ?? []).some(n => n.name.toLowerCase() === String(name).toLowerCase() && itemOf(n));

/** formulas.rs `refuse_stash_name`. */
export function refuseStashName(content, p, name) {
  if (holdsAppData(content, name) && p.force !== true) {
    throw new CommandError('failed', `'${name}' is a name Arkemis keeps its own data in (stored macros, scripts or views). Pass \`force: true\` to change it anyway.`);
  }
}

/** The sheet id a `scope` param names (`Workbook` or absent: null). Throws on an unknown sheet. */
export function scopeId(content, scope, what) {
  if (scope === undefined || scope === null || scope === 'Workbook') return null;
  const sh = typeof scope === 'number' ? content.sheets[scope]
    : content.sheets.find(s => s.id === scope) ?? content.sheets.find(s => s.name.toLowerCase() === String(scope).toLowerCase());
  if (!sh) throw new CommandError('invalid_params', `${what}: no such sheet`);
  return sh.id;
}
/** The scope a name shows in Name Manager: `Workbook` or its sheet's name. */
export const scopeLabel = (content, n) => (n.scope ? content.sheets.find(s => s.id === n.scope)?.name ?? 'Workbook' : 'Workbook');
export const sameScope = (a, b) => (a ?? null) === (b ?? null);

/**
 * formulas.rs `pasteable_names`: [name, '=refersTo'] for the workbook's names and the active
 * sheet's own, hidden names left out, alphabetical; a sheet's name hides the workbook name it shares.
 */
export function pasteableNames(content, si) {
  const sheetId = content.sheets[si]?.id;
  const names = content.names ?? [];
  const local = names.filter(n => !n.hidden && n.scope && n.scope === sheetId);
  const folded = new Set(local.map(n => foldName(n.name)));
  const out = local.map(n => [n.name, `=${nameBody(n)}`]);
  for (const n of names) if (!n.hidden && !n.scope && !folded.has(foldName(n.name))) out.push([n.name, `=${nameBody(n)}`]);
  out.sort((a, b) => (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : a[0].toLowerCase() > b[0].toLowerCase() ? 1 : 0));
  return out;
}

/**
 * formulas.rs `rename_name_in_formulas`: cell formulas and other names' definitions that use
 * `old` follow it to `next`, on the sheets where `old` resolves to the renamed name (its own sheet
 * for a sheet-scoped name; every sheet without a same-named sheet-level name for a workbook one).
 * Writes through the change api; `names` is the list after the rename (indexes are its own).
 */
export function renameNameInFormulas(change, content, old, oldScope, next) {
  const lower = old.toLowerCase();
  const shadowed = new Set((content.names ?? []).filter(n => n.name.toLowerCase() === lower && n.scope).map(n => n.scope));
  const applies = sheetId => (oldScope ? oldScope === sheetId : !shadowed.has(sheetId));
  const rename = e => {
    let hit = false;
    const out = mapExpr(e, x => {
      if (x.t === 'name' && String(x.v).toLowerCase() === lower) { hit = true; return {t: 'name', v: next}; }
      return x;
    });
    return hit ? out : null;
  };
  content.sheets.forEach((sheet, si) => {
    if (!applies(sheet.id) || !sheet.blocks) return;
    for (const bk of Object.keys(sheet.blocks)) {
      const e = blockEntries(sheet.blocks[bk]);
      for (let i = 0; i < e.cells.length; i++) {
        const c = e.cells[i];
        if (c.f === undefined) continue;
        let expr;
        try { expr = parse(c.f); } catch { continue; }
        const out = rename(expr);
        if (out) writeCell(change, content, si, e.rows[i], e.cols[i], {...cellAt(sheet, e.rows[i], e.cols[i]), f: print(out)});
      }
    }
  });
  const names = change.get(['names']) ?? [];
  names.forEach((n, i) => {
    if (n.scope && !applies(n.scope)) return;
    let expr;
    try { expr = parseName(nameBody(n)); } catch { return; }
    const out = rename(expr);
    if (out) change.set(['names', i, 'formula'], print(out));
  });
}

/** inspect.rs `value_json`: null, number, text, boolean, {error}, or rows of values. */
export function valueJson(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof CellError) return {error: v.text};
  if (v instanceof GArray) {
    const rows = [];
    for (let r = 0; r < v.rows; r++) { const row = []; for (let c = 0; c < v.cols; c++) row.push(valueJson(v.get(r, c) ?? null)); rows.push(row); }
    return rows;
  }
  return v;
}
