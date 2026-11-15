// Floating sheet objects: charts, pictures, shapes (and text boxes, icons) and slicers. Their ids,
// anchors and where they stand on the sheet.
// Translated from gridcraft crates/model/src/features.rs (`Anchor`, `AnchorMode`, `Chart`, `Image`,
// `Shape`, `Slicer`), crates/model/src/workbook.rs (`next_object_id`) and crates/engine/src/cmd/
// insert/objects.rs (`move_object`, `delete_object`) at 146161b4b450a56e5e59a083ba0478582d1e602b.
// MIT, see assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.
//
// Stored on the sheet: charts[], images[], shapes[], slicers[], each {id, ..., anchor}. An anchor is
//   {cell: 'H2', dx, dy, width, height, mode: 'moveAndSize'|'moveOnly'|'absolute'} in pixels at 96 dpi:
// the object's top-left corner is `dx, dy` from the cell's, its size `width` x `height`.

import {parseCell, a1} from './addr.mjs';
import {colLeft, rowTop, colAt, rowAt} from '../model/sheet.mjs';

export const OBJECT_KINDS = Object.freeze({chart: 'charts', image: 'images', shape: 'shapes', slicer: 'slicers'});
export const ANCHOR_MODES = Object.freeze(['moveAndSize', 'moveOnly', 'absolute']);

/** Every id taken by a table, chart, image, shape, slicer or PivotTable in the workbook, plus one. */
export function nextObjectId(content) {
  let max = 0;
  for (const sh of content.sheets ?? []) {
    for (const k of ['tables', 'charts', 'images', 'shapes', 'slicers', 'pivots']) for (const o of sh[k] ?? []) if (Number.isInteger(o?.id) && o.id > max) max = o.id;
  }
  return max + 1;
}

/** The stored list name for an object kind (`shape` for text boxes and icons as well). */
export const listName = kind => OBJECT_KINDS[kind] ?? null;

/** The object `id` of `kind` on a sheet, with its index, or null. */
export function findObject(sheet, kind, id) {
  const list = sheet?.[listName(kind)];
  if (!Array.isArray(list)) return null;
  const index = list.findIndex(o => o.id === id);
  return index < 0 ? null : {index, object: list[index]};
}

/** The anchor cell of an object as {row, col}. */
export const anchorCell = anchor => parseCell(anchor?.cell ?? 'A1') ?? {row: 0, col: 0};

/** The object's rectangle in sheet pixels (origin at the top-left of cell A1, headings excluded). */
export function objectRect(sheet, anchor) {
  const c = anchorCell(anchor);
  const x = colLeft(sheet, c.col) + (anchor.dx ?? 0);
  const y = rowTop(sheet, c.row) + (anchor.dy ?? 0);
  return {x, y, w: Math.max(0, anchor.width ?? 0), h: Math.max(0, anchor.height ?? 0)};
}

/** An anchor placing a `width` x `height` object with its top-left corner at sheet pixel (x, y). */
export function anchorAt(sheet, x, y, width, height, mode = 'moveAndSize') {
  const col = colAt(sheet, Math.max(0, x)), row = rowAt(sheet, Math.max(0, y));
  return {cell: a1(row, col), dx: Math.round(x - colLeft(sheet, col)), dy: Math.round(y - rowTop(sheet, row)), width, height, mode};
}

const RANK = {chart: 0, image: 1, shape: 2, slicer: 3};
/**
 * The objects of a sheet back to front: by their `z` (set by Bring Forward and Send Backward), else charts, pictures,
 * shapes, slicers in the order they were added.
 */
export function sheetObjects(sheet) {
  const all = [];
  for (const kind of ['chart', 'image', 'shape', 'slicer']) (sheet?.[listName(kind)] ?? []).forEach((object, i) => all.push({kind, object, key: Number.isFinite(object.z) ? object.z : RANK[kind] * 1_000_000 + i}));
  return all.sort((a, b) => a.key - b.key).map(({kind, object}) => ({kind, object}));
}

/** `{z}` for a new object when the sheet's objects are ordered by z (it goes on top), else nothing. */
export function topZ(sheet) {
  let max = null;
  for (const {object} of sheetObjects(sheet)) if (Number.isFinite(object.z)) max = Math.max(max ?? 0, object.z);
  return max === null ? {} : {z: max + 1};
}

// ---------------------------------------------------------------------------------------------
// Object selection. An object is selected when the kernel selection's primary range names it
// (`/sh:<id>/chart:<n>`, `shape:`, `pic:` or `/slicer:<n>`, address.mjs); the contextual tabs read it
// from there (context.mjs). The grid selection falls back to cell A1 while one is selected.

const ADDRESS_NAME = Object.freeze({chart: 'chart', image: 'pic', shape: 'shape'});
const KIND_OF = Object.freeze({chart: 'chart', pic: 'image', shape: 'shape'});

export const objectAddress = (sheet, kind, id) => (kind === 'slicer' ? `/slicer:${id}` : `/sh:${encodeURIComponent(sheet.id)}/${ADDRESS_NAME[kind]}:${id}`);
/** The kernel selection that selects an object. */
export function objectSelection(sheet, kind, id) {
  const a = objectAddress(sheet, kind, id);
  return {ranges: [{anchor: a, focus: a}], primary: 0};
}
/** The object the kernel selection names: {si, kind, id} or null. */
export function selectedObject(content, ksel) {
  const primary = ksel?.ranges?.[ksel.primary ?? 0]?.anchor ?? '';
  const m = /^\/sh:([^/]+)\/(chart|shape|pic):(\d+)$/.exec(primary);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const si = (content.sheets ?? []).findIndex(s => s.id === id);
    return si < 0 ? null : {si, kind: KIND_OF[m[2]], id: Number(m[3])};
  }
  const sl = /^\/slicer:(\d+)$/.exec(primary);
  if (sl) {
    const id = Number(sl[1]);
    const si = (content.sheets ?? []).findIndex(s => (s.slicers ?? []).some(o => o.id === id));
    return si < 0 ? null : {si, kind: 'slicer', id};
  }
  return null;
}

/**
 * Every object the kernel selection names, the primary one first (several when objects are picked together with Shift or Ctrl, or
 * one of a group is picked): [{si, kind, id}].
 */
export function selectedObjects(content, ksel) {
  const ranges = ksel?.ranges ?? [];
  const primary = ksel?.primary ?? 0;
  const out = [];
  ranges.forEach((r, i) => {
    const one = selectedObject(content, {ranges: [r], primary: 0});
    if (one && !out.some(o => o.kind === one.kind && o.id === one.id)) out[i === primary ? 'unshift' : 'push'](one);
  });
  return out;
}

/** The kernel selection that selects these objects (`items` [{kind, id}] of one sheet), the first primary. */
export function objectsSelection(sheet, items) {
  const ranges = items.map(({kind, id}) => { const a = objectAddress(sheet, kind, id); return {anchor: a, focus: a}; });
  return {ranges, primary: 0};
}

/** The objects of the sheet that picking `kind` `id` takes: itself, or the whole group it is in (`group`). */
export function withGroup(sheet, kind, id) {
  const hit = findObject(sheet, kind, id);
  const g = hit?.object?.group;
  if (!Number.isInteger(g)) return [{kind, id}];
  return sheetObjects(sheet).filter(o => o.object.group === g).map(o => ({kind: o.kind, id: o.object.id}));
}
