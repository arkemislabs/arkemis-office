// Insert > Illustrations and Text: Pictures (over the cells or in a cell), Shapes, Icons, Text Box,
// and the object commands every floating object shares (select, move, resize, anchor mode, delete),
// plus Insert > Sparklines.
// Translated from gridcraft crates/engine/src/cmd/insert/objects.rs (`insert_picture`,
// `insert_shape`, `shape_set_text`, `delete_object`, `move_object`, `set_anchor_mode`,
// `insert_sparkline`) and cmd/insert/cond_format.rs (`insert_icon`) at
// 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Stored on the sheet: images[] {id, anchor, data (base64), mime, alt}, shapes[] {id, kind
// rectangle|roundedRectangle|ellipse|triangle|line|arrow|textBox|icon, anchor, fill, line, text,
// format}, cellPictures {A1: {data, mime, alt}}, sparklines[] {cell, source, kind, color, markers}.
// Objects are selected through the view (`selectedObject`), moved and resized by their anchor.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {a1, parseCell} from '../../lib/addr.mjs';
import {hasDoc, gridSel, targetSheet, cellParamOn, requireSchema2} from '../../lib/edit-targets.mjs';
import {setIn} from '../../lib/edit-parts.mjs';
import {bad, baseDoc, failed} from '../../lib/data-common.mjs';
import {mergeAt} from '../../model/sheet.mjs';
import {nextObjectId, findObject, listName, anchorCell, objectSelection, objectsSelection, selectedObject, selectedObjects, withGroup, topZ, sheetObjects, ANCHOR_MODES, OBJECT_KINDS} from '../../lib/objects.mjs';
import {setGridSelection, rangeSelection} from '../../lib/edit-targets.mjs';
import {rangeCell} from '../../lib/addr.mjs';
import {imageSize, sniffMime, base64ToBytes} from '../../lib/image-info.mjs';
import {ICON_NAMES} from '../../lib/icon-library.mjs';

/** The Icons gallery: a tile for each library icon (the ribbon draws insert-icon-<name>). */
const iconTiles = ICON_NAMES.map(name => ({id: name, label: name, value: name, icon: `insert-icon-${name.replace(/\s+/g, '-')}`}));
const iconsState = ctx => ({...hasDoc(ctx), value: iconTiles});
import {parseRef} from '../../lib/chart-resolve.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: ['crates/engine/src/cmd/insert.rs', 'crates/engine/src/cmd/insert/objects.rs', 'crates/engine/src/cmd/insert/cond_format.rs']};
const SHEET = s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})]));
const KINDS = ['chart', 'image', 'shape', 'slicer'];
const SHAPES = ['rectangle', 'roundedRectangle', 'ellipse', 'oval', 'triangle', 'line', 'arrow', 'textBox'];
const PROTECTED = 'The cell or chart you are trying to change is on a protected sheet. To make a change, unprotect the sheet.';

const HEX = /^#?[0-9a-fA-F]{6}$/;
function colorParam(v, fallback) {
  if (typeof v === 'string' && HEX.test(v.trim())) return `#${v.trim().replace(/^#/, '').toUpperCase()}`;
  return fallback;
}
/** A protected sheet refuses changes to its objects unless Protect Sheet allowed Edit objects. */
const protectedSheet = sheet => !!sheet?.protection?.enabled && !sheet.protection.objects;

/** The image bytes of a `base64` / `dataUrl` param, with their type. */
function pictureBytes(p) {
  const text = p.base64 ?? p.dataUrl;
  if (typeof text !== 'string' || !text) return null;
  const bytes = base64ToBytes(text);
  if (!bytes || !bytes.length) throw bad('insert.picture', 'invalid base64');
  const mime = typeof p.mime === 'string' && p.mime ? p.mime : sniffMime(bytes) ?? (/^data:(image\/[a-z+.-]+)/i.exec(text)?.[1]) ?? 'image/png';
  return {bytes, mime, base64: text.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')};
}

function insertPicture(ctx, p) {
  const placement = p.placement ?? 'overCells';
  if (!['cell', 'overCells'].includes(placement)) throw bad('insert.picture', 'placement must be cell or overCells');
  const pic = pictureBytes(p);
  if (!pic) {
    // No bytes: the person picks a file in the dialog (it asks the system Open dialog).
    ctx.setView({dialogRequest: {seq: (ctx.view?.dialogRequest?.seq ?? 0) + 1, id: 'dialog.insertPicture', init: {placement}}});
    return null;
  }
  const content = baseDoc(ctx);
  const si = targetSheet(ctx, p, ['at']);
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  const sel = gridSel(ctx);
  const alt = typeof p.alt === 'string' ? p.alt : '';
  if (placement === 'cell') {
    if (pic.bytes.length > 16 * 1024 * 1024) throw bad('insert.picture', 'cell pictures must be at most 16 MiB');
    if (!['image/png', 'image/jpeg'].includes(pic.mime)) throw bad('insert.picture', 'cell pictures support PNG and JPEG');
    const size = imageSize(pic.bytes);
    if (!size || size[0] === 0 || size[1] === 0 || size[0] > 8192 || size[1] > 8192 || size[0] * size[1] > 16_000_000) throw bad('insert.picture', 'cell pictures are limited to 8192 pixels per side and 16 million pixels');
    let at = cellParamOn(ctx, p, 'at', si) ?? sel.active;
    const m = mergeAt(sheet, at.row, at.col);
    if (m) at = m.start;
    if (protectedSheet(sheet)) throw failed('The cell you are trying to change is on a protected sheet.');
    setIn(ctx.change, ['sheets', si, 'cellPictures', a1(at.row, at.col)], {data: pic.base64, mime: pic.mime, alt});
    return {cell: a1(at.row, at.col), placement: 'cell'};
  }
  if (pic.bytes.length > 64 * 1024 * 1024) throw bad('insert.picture', 'image larger than 64 MB');
  const [w, h] = imageSize(pic.bytes) ?? [320, 240];
  const at = cellParamOn(ctx, p, 'at', si) ?? sel.active;
  const scale = Math.min(1, 640 / Math.max(1, w));
  const id = nextObjectId(content);
  const img = {id, ...topZ(sheet), anchor: {cell: a1(at.row, at.col), dx: 0, dy: 0, width: p.width ?? Math.round(w * scale), height: p.height ?? Math.round(h * scale),
    // Excel inserts pictures as "Move but don't size with cells" (editAs="oneCell").
    mode: ANCHOR_MODES.includes(p.mode) ? p.mode : 'moveOnly'}, data: pic.base64, mime: pic.mime, alt};
  setIn(ctx.change, ['sheets', si, 'images'], [...(sheet.images ?? []), img]);
  ctx.setSelection(objectSelection(sheet, 'image', id));
  return {image: id};
}

function insertShape(ctx, p) {
  const content = baseDoc(ctx);
  const si = targetSheet(ctx, p, ['at']);
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  const kind = p.kind === 'oval' ? 'ellipse' : SHAPES.includes(p.kind) ? p.kind : 'rectangle';
  const at = cellParamOn(ctx, p, 'at', si) ?? gridSel(ctx).active;
  const box = kind === 'textBox';
  const id = nextObjectId(content);
  const shape = {id, ...topZ(sheet), kind,
    anchor: {cell: a1(at.row, at.col), dx: 0, dy: 0, width: p.width ?? 144, height: p.height ?? (kind === 'line' ? 0 : 96), mode: ANCHOR_MODES.includes(p.mode) ? p.mode : 'moveAndSize'},
    fill: colorParam(p.fill, box ? '#FFFFFF' : {theme: 4, tint: 0}), line: colorParam(p.line, box ? '#808080' : {theme: 4, tint: -0.25}), text: p.text ?? ''};
  setIn(ctx.change, ['sheets', si, 'shapes'], [...(sheet.shapes ?? []), shape]);
  ctx.setSelection(objectSelection(sheet, 'shape', id));
  return {shape: id};
}

function insertIcon(ctx, p) {
  const content = baseDoc(ctx);
  const si = targetSheet(ctx, p, ['at']);
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  const name = String(p.name ?? 'check').toLowerCase();
  if (!ICON_NAMES.includes(name)) throw bad('insert.icons', `no icon named \`${name}\` (${ICON_NAMES.join(', ')})`);
  const size = Math.min(1000, Math.max(8, p.size ?? 48));
  const at = cellParamOn(ctx, p, 'at', si) ?? gridSel(ctx).active;
  const id = nextObjectId(content);
  const shape = {id, ...topZ(sheet), kind: 'icon', anchor: {cell: a1(at.row, at.col), dx: 4, dy: 4, width: size, height: size, mode: ANCHOR_MODES.includes(p.mode) ? p.mode : 'moveAndSize'},
    fill: colorParam(p.color, {theme: 1, tint: 0}), line: 'auto', text: name};
  setIn(ctx.change, ['sheets', si, 'shapes'], [...(sheet.shapes ?? []), shape]);
  ctx.setSelection(objectSelection(sheet, 'shape', id));
  return {shape: id};
}

const SHAPE_TEXT_MAX = 32_767;
function shapeSetText(ctx, p) {
  const content = baseDoc(ctx);
  const si = gridSel(ctx).sheet;
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  if (!Number.isInteger(p.id)) throw bad('shape.setText', '`id` must be a text box id');
  const text = p.text;
  if ([...text].length > SHAPE_TEXT_MAX) throw bad('shape.setText', '`text` is longer than 32,767 characters');
  const hit = findObject(sheet, 'shape', p.id);
  if (!hit) throw bad('shape.setText', 'no such text box');
  if (hit.object.kind !== 'textBox') throw bad('shape.setText', 'the shape is not a text box');
  // Sheet protection locks drawing objects.
  if (protectedSheet(sheet)) throw failed(PROTECTED);
  if (hit.object.text === text) return null;
  ctx.change.set(['sheets', si, 'shapes', hit.index, 'text'], text);
  return null;
}

function targetObject(ctx, p, cmd) {
  const content = baseDoc(ctx);
  const si = gridSel(ctx).sheet;
  requireSchema2(ctx, si);
  const sheet = content.sheets[si];
  // Without `kind` and `id` the object is the selected one, as the Format tabs' Size boxes act on it.
  const picked = selectedObject(content, ctx.selection);
  const kind = p.kind ?? (picked && picked.si === si ? picked.kind : undefined);
  const id = Number.isInteger(p.id) ? p.id : picked && picked.si === si && picked.kind === kind ? picked.id : undefined;
  if (!OBJECT_KINDS[kind]) throw bad(cmd, `kind must be ${KINDS.join(', ')}`);
  if (!Number.isInteger(id)) throw bad(cmd, 'missing `id`');
  const hit = findObject(sheet, kind, id);
  if (!hit) throw bad(cmd, 'no such object');
  return {si, sheet, list: listName(kind), ...hit};
}

function deleteObject(ctx, p) {
  const {si, sheet, list, index, object} = targetObject(ctx, p, 'object.delete');
  if (protectedSheet(sheet)) throw failed(PROTECTED);
  ctx.change.set(['sheets', si, list], sheet[list].filter((_, i) => i !== index));
  const sel = selectedObject(ctx.doc, ctx.selection);
  if (sel && sel.id === p.id && sel.kind === p.kind) setGridSelection(ctx, rangeSelection(si, rangeCell(anchorCell(object.anchor))));
  return null;
}

function moveObject(ctx, p) {
  const {si, sheet, list, index, object} = targetObject(ctx, p, 'object.move');
  if (protectedSheet(sheet)) throw failed(PROTECTED);
  const a = {...object.anchor};
  const at = cellParamOn(ctx, p, 'at', si);
  if (at) a.cell = a1(at.row, at.col);
  if (typeof p.dx === 'number') a.dx = p.dx;
  if (typeof p.dy === 'number') a.dy = p.dy;
  if (typeof p.width === 'number') a.width = Math.min(10000, Math.max(1, p.width));
  if (typeof p.height === 'number') a.height = Math.min(10000, Math.max(0, p.height));
  ctx.change.set(['sheets', si, list, index, 'anchor'], a);
  return null;
}

/** Excel's "Move and size with cells" / "Move but don't size with cells" / "Don't move or size with cells". */
function setAnchorMode(ctx, p) {
  if (!['chart', 'image', 'shape'].includes(p.kind)) throw bad('object.setAnchorMode', 'kind must be chart, image or shape');
  if (!ANCHOR_MODES.includes(p.mode)) throw bad('object.setAnchorMode', 'mode must be moveAndSize, moveOnly or absolute');
  const {si, list, index, object} = targetObject(ctx, p, 'object.setAnchorMode');
  ctx.change.set(['sheets', si, list, index, 'anchor'], {...object.anchor, mode: p.mode});
  return {mode: p.mode};
}

function selectObject(ctx, p) {
  const content = baseDoc(ctx);
  const si = gridSel(ctx).sheet;
  const sheet = content.sheets[si];
  if (p.kind === undefined || p.id === undefined) { if (selectedObject(content, ctx.selection)) setGridSelection(ctx, rangeSelection(si, rangeCell({row: 0, col: 0}))); return {selected: null}; }
  if (!findObject(sheet, p.kind, p.id)) throw bad('object.select', 'no such object');
  // Picking one of a group picks the whole group; `mode` add (Shift) or toggle (Ctrl) works on the objects already picked.
  const members = p.kind === 'slicer' ? [{kind: p.kind, id: p.id}] : withGroup(sheet, p.kind, p.id);
  const has = (list, m) => list.some(o => o.kind === m.kind && o.id === m.id);
  const now = selectedObjects(content, ctx.selection).filter(o => o.si === si && o.kind !== 'slicer').map(({kind, id}) => ({kind, id}));
  let items = members;
  if (p.mode === 'add') items = [...now.filter(o => !has(members, o)), ...members];
  else if (p.mode === 'toggle') items = has(now, members[0]) ? now.filter(o => !has(members, o)) : [...now, ...members];
  if (!items.length) { setGridSelection(ctx, rangeSelection(si, rangeCell({row: 0, col: 0}))); return {selected: null}; }
  ctx.setSelection(items.length === 1 ? objectSelection(sheet, items[0].kind, items[0].id) : objectsSelection(sheet, items));
  return {selected: {kind: p.kind, id: p.id}, count: items.length};
}

function listObjects(ctx) {
  const content = baseDoc(ctx);
  const sheet = content.sheets[gridSel(ctx).sheet];
  const out = [];
  for (const {kind, object: o} of sheetObjects(sheet)) out.push({kind, id: o.id, anchor: o.anchor, ...(kind === 'shape' ? {shape: o.kind} : {}), ...(kind === 'chart' ? {chart: o.kind} : {})});
  return out;
}

const SPARK = ['line', 'column', 'winLoss'];
function insertSparkline(ctx, p) {
  const content = baseDoc(ctx);
  const si = targetSheet(ctx, p, ['range', 'location']);
  requireSchema2(ctx, si);
  if (typeof p.range !== 'string' || !p.range) throw bad('insert.sparkline', 'missing `range`');
  if (typeof p.location !== 'string' || !p.location) throw bad('insert.sparkline', 'missing `location`');
  if (!parseRef(content, si, p.range)) throw bad('insert.sparkline', `\`${p.range}\` is not a range`);
  const loc = cellParamOn(ctx, p, 'location', si);
  if (!loc) throw bad('insert.sparkline', 'invalid `location`');
  const key = a1(loc.row, loc.col);
  const kept = (content.sheets[si].sparklines ?? []).filter(x => x.cell !== key);
  const body = p.range.includes('!') ? p.range : `${p.range}`;
  setIn(ctx.change, ['sheets', si, 'sparklines'], [...kept, {cell: key, source: body, kind: SPARK.includes(p.type) ? p.type : 'line', color: {theme: 4, tint: 0}, markers: p.markers === true}]);
  return null;
}

export default defineCommands({
  family: 'insert/objects',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'insert.picture', label: 'Picture', risk: 'edit', dialog: 'dialog.insertPicture',
      description: 'Insert a picture (PNG or JPEG bytes as `base64`): placement overCells (a floating picture, default) or cell (inside the cell), at (top-left cell), width, height, alt, mode. With no picture it opens the Insert Picture dialog.',
      params: s.object({base64: s.optional(s.string({max: 90_000_000})), dataUrl: s.optional(s.string({max: 90_000_000})), mime: s.optional(s.string({max: 60})), at: s.optional(s.string({max: 100})), sheet: SHEET,
        width: s.optional(s.number({min: 1, max: 10000})), height: s.optional(s.number({min: 1, max: 10000})), alt: s.optional(s.string({max: 1000})), mode: s.optional(s.enum(ANCHOR_MODES)),
        placement: s.optional(s.enum(['cell', 'overCells']))}),
      state: hasDoc,
      run: insertPicture,
    },
    {
      id: 'insert.shape', label: 'Shapes', risk: 'edit',
      description: 'Insert a shape: kind rectangle|roundedRectangle|ellipse|triangle|line|arrow|textBox, at (top-left cell), width, height, text, fill and line (#RRGGBB).',
      params: s.object({kind: s.optional(s.enum(SHAPES)), at: s.optional(s.string({max: 100})), sheet: SHEET, width: s.optional(s.number({min: 0, max: 10000})), height: s.optional(s.number({min: 0, max: 10000})),
        text: s.optional(s.string({max: SHAPE_TEXT_MAX})), fill: s.optional(s.string({max: 20})), line: s.optional(s.string({max: 20})), mode: s.optional(s.enum(ANCHOR_MODES))}),
      state: hasDoc,
      run: insertShape,
    },
    {
      id: 'insert.icons', label: 'Icons', risk: 'edit',
      description: `Insert an icon from the library (${ICON_NAMES.join(', ')}): name, at, size (default 48), color (#RRGGBB).`,
      params: s.object({name: s.optional(s.string({max: 40})), at: s.optional(s.string({max: 100})), sheet: SHEET, size: s.optional(s.number({min: 8, max: 1000})), color: s.optional(s.string({max: 20})), mode: s.optional(s.enum(ANCHOR_MODES))}),
      state: iconsState,
      run: insertIcon,
    },
    {
      id: 'insert.textBox', label: 'Text Box', risk: 'edit',
      description: 'Insert a text box: at, width, height, text.',
      params: s.object({at: s.optional(s.string({max: 100})), sheet: SHEET, width: s.optional(s.number({min: 0, max: 10000})), height: s.optional(s.number({min: 0, max: 10000})), text: s.optional(s.string({max: SHAPE_TEXT_MAX}))}),
      state: hasDoc,
      run: (ctx, p) => insertShape(ctx, {...p, kind: 'textBox'}),
    },
    {
      id: 'shape.setText', label: 'Edit Text Box', risk: 'edit',
      description: 'Set the text of a text box by its id.',
      params: s.object({id: s.integer({min: 0}), text: s.string({max: SHAPE_TEXT_MAX})}),
      state: hasDoc,
      run: shapeSetText,
    },
    {
      id: 'object.delete', label: 'Delete Object', risk: 'edit',
      description: 'Delete a chart, picture, shape or slicer by kind and id.',
      params: s.object({kind: s.enum(KINDS), id: s.integer({min: 0})}),
      state: hasDoc,
      run: deleteObject,
    },
    {
      id: 'object.move', label: 'Move Object', risk: 'edit',
      description: 'Move or resize an object: at (top-left cell), dx, dy (pixels from the cell), width, height.',
      params: s.object({kind: s.optional(s.enum(KINDS)), id: s.optional(s.integer({min: 0})), at: s.optional(s.string({max: 100})), dx: s.optional(s.number()), dy: s.optional(s.number()),
        width: s.optional(s.number({min: 1, max: 10000})), height: s.optional(s.number({min: 0, max: 10000}))}),
      state: hasDoc,
      run: moveObject,
    },
    {
      id: 'object.setAnchorMode', label: 'Object Properties', risk: 'edit',
      description: 'Whether an object moves and sizes with its cells, moves only, or stays put: moveAndSize|moveOnly|absolute.',
      params: s.object({kind: s.enum(['chart', 'image', 'shape']), id: s.integer({min: 0}), mode: s.enum(ANCHOR_MODES)}),
      state: hasDoc,
      run: setAnchorMode,
    },
    {
      id: 'object.select', label: 'Select Object', risk: 'edit', undo: 'none', effect: 'view',
      description: 'Select a floating object (chart, picture, shape, slicer) by kind and id; with neither, clear the object selection.',
      params: s.object({kind: s.optional(s.enum(KINDS)), id: s.optional(s.integer({min: 0})), mode: s.optional(s.enum(['add', 'toggle']))}),
      state: hasDoc,
      run: selectObject,
    },
    {
      id: 'object.list', label: 'List Objects', risk: 'read',
      description: 'The floating objects on the active sheet: [{kind, id, anchor}].',
      params: s.object({}),
      state: hasDoc,
      run: listObjects,
    },
    {
      id: 'insert.sparkline', label: 'Sparklines', risk: 'edit', dialog: 'dialog.sparkline',
      description: 'Insert a sparkline in cell `location` from `range`: type line|column|winLoss, markers.',
      params: s.object({range: s.optional(s.string({max: 4096})), location: s.optional(s.string({max: 100})), sheet: SHEET, type: s.optional(s.enum(SPARK)), markers: s.optional(s.boolean())}),
      state: hasDoc,
      run: insertSparkline,
    },
  ],
});
