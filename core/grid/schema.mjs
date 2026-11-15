// Grid's schema-2 content: creation, validation, app-specific change ops and the /v1 legacy
// command (docs/architecture.md 4.2, 16.2, 18; F:grid).
// Limits and defaults follow gridcraft crates/model/src/{workbook.rs, sheet.rs, style.rs} and
// crates/core/src/addr.rs at 146161b4b450a56e5e59a083ba0478582d1e602b: 1,048,576 rows by
// 16,384 columns, 255 sheets, 31-character sheet names, 32,767 characters a cell, 8,192 a formula.
// The content shape is documented in model/workbook.mjs. No DOM, no Node built-ins.

import {MAX_ROWS, MAX_COLS, parseRange} from './lib/addr.mjs';
import {MAX_FORMULA_LEN} from './lib/formula.mjs';
import {parseKey, blockOf, BLOCK_ROWS, writeCell} from './model/store.mjs';
import {createWorkbook, MAX_SHEETS} from './model/workbook.mjs';
import {checkSheetName} from './model/sheet.mjs';
import {applyGridOp} from './model/structure.mjs';
import {enterInput} from './model/input.mjs';
import {createTransaction} from '../kernel/change.mjs';

export const SCHEMA_VERSION = 2;
export const MAX_CELL_TEXT = 32_767;
export const MAX_STYLES = 65_000;
export {MAX_ROWS, MAX_COLS, BLOCK_ROWS, MAX_SHEETS};

let counter = 0;
const uid = () => `${Date.now().toString(36).slice(-5)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** A new workbook (`Sheet1`, the Normal style, no names). */
export function createContent(_title, {id} = {}) {
  return createWorkbook(id ? () => id : uid);
}

const fail = message => { throw new Error(`Invalid workbook: ${message}`); };
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const COLOR = /^#[0-9a-f]{6}$/i;

function validateLines(map, max, what) {
  if (map === undefined) return;
  if (!isObj(map)) fail(`${what} is a map of line infos`);
  for (const [k, v] of Object.entries(map)) {
    const n = Number(k);
    if (!Number.isInteger(n) || n < 0 || n >= max || !isObj(v)) fail(`bad ${what} entry ${k}`);
    if (v.size !== undefined && !(Number.isFinite(v.size) && v.size >= 0 && v.size <= 2200)) fail(`bad size in ${what} ${k}`);
    if (v.s !== undefined && !(Number.isInteger(v.s) && v.s >= 0)) fail(`bad style in ${what} ${k}`);
  }
}

function validateCell(key, cell, where) {
  if (!isObj(cell)) fail(`${where}${key} is not a cell`);
  if (cell.f !== undefined && (typeof cell.f !== 'string' || cell.f.length > MAX_FORMULA_LEN)) fail(`${where}${key} has a bad formula`);
  const v = cell.v;
  if (v !== undefined && v !== null) {
    if (typeof v === 'string') { if (v.length > MAX_CELL_TEXT) fail(`${where}${key} holds more than ${MAX_CELL_TEXT} characters`); }
    else if (typeof v === 'number') { if (!Number.isFinite(v)) fail(`${where}${key} holds a number that is not finite`); }
    else if (typeof v !== 'boolean' && !(isObj(v) && typeof v.e === 'string')) fail(`${where}${key} holds a bad value`);
  }
  if (cell.s !== undefined && !(Number.isInteger(cell.s) && cell.s >= 0)) fail(`${where}${key} has a bad style id`);
  if (cell.a !== undefined && !parseRange(cell.a)) fail(`${where}${key} has a bad array range`);
}

/** Throws unless `c` is a well-formed schema-2 workbook. */
export function validateContent(c) {
  if (!isObj(c)) fail('content is an object');
  if (!Array.isArray(c.sheets) || !c.sheets.length || c.sheets.length > MAX_SHEETS) fail(`a workbook has 1 to ${MAX_SHEETS} sheets`);
  if (c.dateSystem !== undefined && c.dateSystem !== 1900 && c.dateSystem !== 1904) fail('dateSystem is 1900 or 1904');
  if (c.styles !== undefined && (!Array.isArray(c.styles) || c.styles.length > MAX_STYLES || c.styles.some(s => !isObj(s)))) fail('styles is a list of style objects');
  const styleCount = Array.isArray(c.styles) && c.styles.length ? c.styles.length : 1;
  const ids = new Set(), names = new Set();
  for (const sh of c.sheets) {
    if (!isObj(sh) || typeof sh.id !== 'string' || !sh.id || ids.has(sh.id)) fail('every sheet has a unique id');
    ids.add(sh.id);
    if (typeof sh.name !== 'string') fail('every sheet has a name');
    const nameError = checkSheetName({sheets: []}, sh.name);
    if (nameError) fail(`sheet name ${JSON.stringify(sh.name)}: ${nameError}`);
    if (names.has(sh.name.toLowerCase())) fail(`two sheets are named ${sh.name}`);
    names.add(sh.name.toLowerCase());
    if (sh.cells !== undefined) fail(`sheet ${sh.name} uses schema-1 cells (migrate it)`);
    if (!isObj(sh.blocks)) fail(`sheet ${sh.name} has no blocks`);
    for (const [bk, block] of Object.entries(sh.blocks)) {
      const b = Number(bk);
      if (!Number.isInteger(b) || b < 0 || b >= MAX_ROWS / BLOCK_ROWS || !isObj(block)) fail(`sheet ${sh.name} has a bad block ${bk}`);
      for (const [key, cell] of Object.entries(block)) {
        const p = parseKey(key);
        if (!p || p[0] >= MAX_ROWS || p[1] >= MAX_COLS || blockOf(p[0]) !== b) fail(`cell ${key} is in the wrong block`);
        validateCell(key, cell, `${sh.name}!`);
        if (cell.s !== undefined && cell.s >= styleCount) fail(`${sh.name}!${key} uses a style that does not exist`);
      }
    }
    validateLines(sh.rows, MAX_ROWS, 'rows');
    validateLines(sh.cols, MAX_COLS, 'cols');
    if (sh.merges !== undefined) {
      if (!Array.isArray(sh.merges) || sh.merges.length > 100_000) fail('merges is a list of ranges');
      const rs = sh.merges.map(m => parseRange(m) ?? fail(`bad merge ${m}`));
      if (rs.length <= 2000) {
        for (let i = 0; i < rs.length; i++) for (let j = 0; j < i; j++) {
          const x = rs[i], y = rs[j];
          if (x.start.row <= y.end.row && y.start.row <= x.end.row && x.start.col <= y.end.col && y.start.col <= x.end.col) fail('merged ranges overlap');
        }
      }
    }
    if (sh.freeze !== undefined && !(isObj(sh.freeze) && Number.isInteger(sh.freeze.rows ?? 0) && Number.isInteger(sh.freeze.cols ?? 0)
      && (sh.freeze.rows ?? 0) >= 0 && (sh.freeze.cols ?? 0) >= 0 && (sh.freeze.rows ?? 0) < MAX_ROWS && (sh.freeze.cols ?? 0) < MAX_COLS)) fail('bad freeze');
    if (sh.zoom !== undefined && !(Number.isInteger(sh.zoom) && sh.zoom >= 10 && sh.zoom <= 400)) fail('zoom is 10 to 400');
    if (sh.tabColor !== undefined && sh.tabColor !== null && !COLOR.test(sh.tabColor)) fail('tabColor is #RRGGBB');
    if (sh.hidden !== undefined && !['hidden', 'veryHidden', false].includes(sh.hidden)) fail('hidden is hidden or veryHidden');
    if (sh.tables !== undefined && (!Array.isArray(sh.tables) || sh.tables.some(t => !isObj(t) || typeof t.name !== 'string' || !parseRange(t.range ?? '')))) fail('bad table');
  }
  if (!ids.has(c.activeSheetId)) fail('activeSheetId names a sheet');
  if (c.names !== undefined) {
    if (!Array.isArray(c.names) || c.names.length > 100_000) fail('names is a list');
    const seen = new Set();
    for (const n of c.names) {
      if (!isObj(n) || typeof n.name !== 'string' || !/^[\p{L}_\\][\p{L}\p{N}_.\\]{0,254}$/u.test(n.name) || typeof n.formula !== 'string' || n.formula.length > MAX_FORMULA_LEN) fail('bad defined name');
      if (n.scope !== undefined && !ids.has(n.scope)) fail(`name ${n.name} is scoped to a sheet that does not exist`);
      const k = `${n.scope ?? ''}:${n.name.toLowerCase()}`;
      if (seen.has(k)) fail(`duplicate name ${n.name}`);
      seen.add(k);
    }
  }
  if (c.calc !== undefined && (!isObj(c.calc) || (c.calc.mode !== undefined && !['auto', 'manual', 'autoNoTables'].includes(c.calc.mode)))) fail('bad calculation options');
  return c;
}

/** App-specific change ops (kernel change.apply): structural edits. */
export const apply = applyGridOp;

/** /v1 `set_cells` on a schema-2 workbook: typed input per cell, as the legacy bridge sends it. */
export function applyLegacyCommand(content, command) {
  if (command?.type !== 'set_cells') throw new Error('Unsupported command');
  const si = content.sheets.findIndex(s => s.id === command.sheetId);
  if (si < 0) throw new Error('Sheet not found');
  const tx = createTransaction({content}, {appApply: applyGridOp});
  for (const [address, cell] of Object.entries(command.cells ?? {})) {
    const p = parseKey(address.replaceAll('$', '').toUpperCase());
    if (!p) throw new Error(`Invalid cell address ${address}`);
    const input = typeof cell === 'string' ? cell : typeof cell?.value === 'string' ? cell.value : '';
    enterInput(tx.api, tx.content, si, p[0], p[1], input);
  }
  return tx.content;
}

export {writeCell};
