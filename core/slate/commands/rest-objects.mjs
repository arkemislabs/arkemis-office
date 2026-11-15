// Objects with no Office program behind them (U:slate/rest): Spreadsheet, Convert to Spreadsheet,
// Diagram, Scanned Image.
//
// Slate has no ArtCraft upstream; ids and args are docs/spec/slate.json `insert.spreadsheet`,
// `insert.diagram`, `insert.scannedImage` and `table.convertToSpreadsheet`. OneNote embeds an
// Excel worksheet and a Visio drawing; the app has neither program, so it draws its own:
//   * Spreadsheet (new, or from an .xlsx or .csv file) puts a worksheet on the page. Cells are typed
//     as in a worksheet, a formula starts with =, and are calculated by the Grid engine
//     (core/slate/lib/sheet.mjs). Convert to Spreadsheet replaces a table by a worksheet of its text;
//   * Diagram draws a flowchart, hierarchy, process or cycle from an outline (core/slate/lib/diagram.mjs);
//   * Scanned Image inserts a picture from a file (the app cannot reach a scanner) and, when asked,
//     reads the text in it offline through the app's OCR worker and keeps that text with the picture
//     (its alternative text, which Search reads).
// Not checked against upstream (there is none).

import {Fragment} from '@tiptap/pm/model';
import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {schema} from '../schema.mjs';
import {pageDoc} from '../model/canvas.mjs';
import {blockIndex} from '../model/page.mjs';
import {editPage} from '../lib/format-text.mjs';
import {bid, insertBlock, needPage, pageReady} from '../lib/insert-point.mjs';
import {needTable, tableState} from '../lib/table.mjs';
import {DIAGRAM_KINDS, SAMPLE, cleanOutline, parseOutline} from '../lib/diagram.mjs';
import {bytesOf, probe} from '../../quill/lib/insert-objects.mjs';
import {pictureNode, placeObject, readFile} from './insert.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/insert.spreadsheet', 'docs/spec/slate.json#commands/insert.diagram',
  'docs/spec/slate.json#commands/insert.scannedImage', 'docs/spec/slate.json#commands/table.convertToSpreadsheet']};
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };
const sheetLib = () => import('../lib/sheet.mjs');
const MAX_SHEET_FILE = 8 * 1024 * 1024;
const idParam = s.string({min: 1, max: 80, description: 'Object id (the /pg:<page>/media:<id> of it)'});

/** The object node a command means: `id`, on `page` (default: the selected page). */
function objectOf(ctx, p, type) {
  const pageId = p.page ?? needPage(ctx);
  need(ctx.doc.pages[pageId], 'not_found', `No page ${pageId}`);
  const hit = blockIndex(pageDoc(ctx, pageId)).get(p.id);
  need(hit && hit.node.type.name === type, 'not_found', `No ${type} ${p.id} on this page`, {address: `/pg:${pageId}/media:${p.id}`});
  return {pageId, hit};
}
const setAttrs = (ctx, pageId, hit, attrs) => editPage(ctx, pageId, tr => tr.setNodeMarkup(hit.pos, null, {...hit.node.attrs, ...attrs}), pageDoc(ctx, pageId));

/** The worksheet a file holds: its first sheet as {rows, cols, cells}. */
async function sheetFromFile(name, bytes) {
  need(bytes.length <= MAX_SHEET_FILE, 'too_large', `A workbook to insert is at most ${MAX_SHEET_FILE / 1024 / 1024} MB`, {path: '/data'});
  const ext = String(name).split('.').pop().toLowerCase();
  const lib = await sheetLib();
  let content;
  try {
    if (ext === 'xlsx' || ext === 'xlsm') content = await (await import('../../grid/formats/xlsx-read.mjs')).read(bytes);
    else if (ext === 'csv') content = (await import('../../grid/formats/csv-read.mjs')).read(bytes);
    else if (ext === 'tsv' || ext === 'tab') content = (await import('../../grid/formats/tsv-read.mjs')).read(bytes);
  } catch (e) { throw new CommandError('invalid_params', `${name} could not be read as a workbook: ${e?.message ?? e}`, {path: '/data'}); }
  need(content, 'invalid_params', `${name} is not a workbook the app can read (use .xlsx, .csv or .tsv)`, {path: '/name'});
  return lib.cellsOfWorkbook(content);
}

export default defineCommands({
  family: 'rest-objects',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    // --- Spreadsheet ------------------------------------------------------------------------------
    {
      id: 'insert.spreadsheet', label: 'Spreadsheet', risk: 'edit',
      description: 'Put a worksheet on the page at the caret: a new one (`rows` by `cols`, default 6 by 5, at most 100 by 26) or, with mode "existing", the first sheet of a workbook file (`name` ending .xlsx, .csv or .tsv, and `data`, base64; without them the system Open dialog asks). Cells are typed as in a worksheet, a formula starts with = and is calculated by the Grid engine. The worksheet is selected.',
      params: s.object({
        mode: s.optional(s.enum(['new', 'existing'])),
        rows: s.optional(s.number({min: 1, max: 100, integer: true})), cols: s.optional(s.number({min: 1, max: 26, integer: true})),
        name: s.optional(s.string({min: 1, max: 255})), data: s.optional(s.string({max: 40_000_000, description: 'The workbook file, base64'})),
        cells: s.optional(s.record(s.string({max: 500}), {description: 'Typed cells for a new worksheet, {A1: "=SUM(B1:B3)"}'})),
      }),
      state: pageReady,
      async run(ctx, p) {
        const lib = await sheetLib();
        let attrs;
        let clipped = false;
        if (p.mode === 'existing') {
          let file = typeof p.data === 'string' ? {name: p.name ?? 'Workbook.xlsx', data: p.data} : null;
          if (!file) {
            need(typeof ctx.host?.pickDocument === 'function', 'unavailable', 'The system Open dialog is not available here; pass `name` and `data` (base64)');
            const f = await ctx.host.pickDocument({all: true});
            if (!f) return {cancelled: true};
            file = {name: p.name ?? f.name, data: f.data};
          }
          const bytes = bytesOf(file.data);
          need(bytes && bytes.length, 'invalid_params', 'data is not base64', {path: '/data'});
          const r = await sheetFromFile(file.name, bytes);
          clipped = r.clipped;
          attrs = lib.sheetAttrs({rows: r.rows, cols: r.cols, cells: r.cells, title: file.name.replace(/\.[^.]+$/, '')});
        } else attrs = lib.sheetAttrs({rows: p.rows, cols: p.cols, cells: p.cells ?? {}});
        const node = schema.nodes.spreadsheet.create({id: bid(ctx), ...attrs});
        const placed = placeObject(ctx, node);
        return {...placed, rows: attrs.rows, cols: attrs.cols, cells: Object.keys(attrs.cells).length, clipped};
      },
    },
    {
      id: 'spreadsheet.setCell', label: 'Edit Cell', risk: 'edit',
      description: 'Type into a cell of a worksheet on the page (A1 style; text starting with = is a formula; empty text clears the cell). Every cell is calculated again.',
      params: s.object({id: idParam, ref: s.string({min: 2, max: 5, description: 'Cell name, such as B3'}), text: s.string({max: 500}), page: s.optional(s.string({min: 1, max: 80}))}),
      state: pageReady,
      async run(ctx, p) {
        const {pageId, hit} = objectOf(ctx, p, 'spreadsheet');
        const lib = await sheetLib();
        const next = lib.withCell(hit.node.attrs, p.ref.toUpperCase(), p.text);
        const ref = p.ref.toUpperCase();
        if (JSON.stringify(next.cells) === JSON.stringify(hit.node.attrs.cells ?? {})) return {changed: false, shown: next.shown[ref] ?? ''};
        setAttrs(ctx, pageId, hit, {cells: next.cells, shown: next.shown});
        return {changed: true, ref, shown: next.shown[ref] ?? ''};
      },
    },
    {
      id: 'spreadsheet.resize', label: 'Resize Spreadsheet', risk: 'edit',
      description: 'Set the number of rows (1 to 100) and columns (1 to 26) of a worksheet on the page: growing adds empty cells, shrinking drops the cells outside.',
      params: s.object({id: idParam, rows: s.optional(s.number({min: 1, max: 100, integer: true})), cols: s.optional(s.number({min: 1, max: 26, integer: true})), page: s.optional(s.string({min: 1, max: 80}))}),
      state: pageReady,
      async run(ctx, p) {
        const {pageId, hit} = objectOf(ctx, p, 'spreadsheet');
        const lib = await sheetLib();
        const a = hit.node.attrs;
        const rows = p.rows ?? a.rows, cols = p.cols ?? a.cols;
        if (rows === a.rows && cols === a.cols) return {changed: false, rows, cols};
        const next = lib.sheetAttrs({rows, cols, cells: a.cells, title: a.title});
        setAttrs(ctx, pageId, hit, next);
        return {changed: true, rows: next.rows, cols: next.cols};
      },
    },
    {
      id: 'table.convertToSpreadsheet', label: 'Convert to Spreadsheet', risk: 'edit',
      description: 'Replace the table the caret is in by a worksheet holding each cell\'s text (a table of at most 100 rows and 26 columns); the worksheet is selected. Undo brings the table back.',
      params: s.object({}),
      state: tableState,
      async run(ctx) {
        const sel = needTable(ctx);
        const t = sel.table.node;
        const rows = [];
        t.forEach(r => { const cells = []; r.forEach(c => cells.push(c.textContent)); rows.push(cells); });
        need(rows.length <= 100 && Math.max(...rows.map(r => r.length)) <= 26, 'too_large', 'A spreadsheet on a page holds at most 100 rows and 26 columns');
        const lib = await sheetLib();
        const r = lib.cellsOfRows(rows);
        const attrs = lib.sheetAttrs(r);
        const node = schema.nodes.spreadsheet.create({id: bid(ctx), ...attrs});
        const para = schema.nodes.paragraph.create({id: bid(ctx)}, Fragment.from(node));
        editPage(ctx, sel.pageId, tr => { tr.replaceWith(sel.table.pos, sel.table.pos + t.nodeSize, para); }, sel.doc);
        const a = `/pg:${sel.pageId}/media:${node.attrs.id}`;
        ctx.setSelection({ranges: [{anchor: a, focus: a}], primary: 0});
        return {object: a, rows: attrs.rows, cols: attrs.cols};
      },
    },

    // --- Diagram ----------------------------------------------------------------------------------
    {
      id: 'insert.diagram', label: 'Diagram', risk: 'edit',
      description: 'Put a diagram on the page at the caret, drawn from an outline of one line per box (`text`; a starter outline for the kind when omitted): flowchart, hierarchy (indent a line to hang it under the one above), process or cycle. In a flowchart (Start) is a rounded box and <Is it done?> a diamond. The diagram is selected; double-click it to change it.',
      params: s.object({mode: s.optional(s.enum(['new'])), kind: s.optional(s.enum(DIAGRAM_KINDS)), text: s.optional(s.string({max: 4000}))}),
      state: pageReady,
      run(ctx, p) {
        const kind = p.kind ?? 'flowchart';
        const text = cleanOutline(p.text ?? SAMPLE[kind]);
        need(parseOutline(text).length, 'invalid_params', 'A diagram needs at least one line of text', {path: '/text'});
        const node = schema.nodes.diagram.create({id: bid(ctx), kind, text});
        const placed = placeObject(ctx, node);
        return {...placed, kind, boxes: parseOutline(text).length};
      },
    },
    {
      id: 'diagram.edit', label: 'Edit Diagram', risk: 'edit',
      description: 'Change the outline (`text`) or the kind of a diagram on the page.',
      params: s.object({id: idParam, kind: s.optional(s.enum(DIAGRAM_KINDS)), text: s.optional(s.string({max: 4000})), page: s.optional(s.string({min: 1, max: 80}))}),
      state: pageReady,
      run(ctx, p) {
        const {pageId, hit} = objectOf(ctx, p, 'diagram');
        const kind = p.kind ?? hit.node.attrs.kind;
        const text = p.text === undefined ? hit.node.attrs.text : cleanOutline(p.text);
        need(parseOutline(text).length, 'invalid_params', 'A diagram needs at least one line of text', {path: '/text'});
        if (kind === hit.node.attrs.kind && text === hit.node.attrs.text) return {changed: false};
        setAttrs(ctx, pageId, hit, {kind, text});
        return {changed: true, kind, boxes: parseOutline(text).length};
      },
    },

    // --- Scanned Image ----------------------------------------------------------------------------
    {
      id: 'insert.scannedImage', label: 'Scanned Image', risk: 'edit',
      description: 'Insert a picture from an image file (a scan or a photo; the app cannot reach a scanner) at the caret; with `recognize` (default true) the text in it is read offline and kept as the picture\'s alternative text, which Search finds; with `insertText` it is also typed under the picture, in its own paragraphs. `data` is the picture (base64 or a data URL); without it the system Open dialog asks.',
      params: s.object({
        data: s.optional(s.string({max: 40_000_000})), name: s.optional(s.string({min: 1, max: 255})),
        recognize: s.optional(s.boolean()), insertText: s.optional(s.boolean()),
        width: s.optional(s.number({min: 8, max: 4000})),
      }),
      state: pageReady,
      async run(ctx, p) {
        const file = await readFile(ctx, p, {image: true});
        if (!file) return {cancelled: true};
        const bytes = bytesOf(file.data);
        need(bytes && bytes.length, 'invalid_params', 'data is not base64', {path: '/data'});
        need(!probe(bytes).notPicture, 'invalid_params', 'That file is not a picture the app can show', {path: '/data'});
        let text = '', ocr = 'off';
        if (p.recognize !== false) {
          if (typeof ctx.host?.ocrImage !== 'function') ocr = 'unavailable';
          else {
            try { text = String((await ctx.host.ocrImage(file.data))?.text ?? '').replace(/\r/g, '').trim(); ocr = text ? 'text' : 'none'; } catch (e) { ocr = `failed: ${e?.message ?? e}`; }
          }
        }
        const alt = text ? text.replace(/\s+/g, ' ').slice(0, 1000) : '';
        const picture = pictureNode(ctx, {name: p.name ?? file.name, alt: alt || 'Scanned image', width: p.width}, bytes);
        // The scan goes in a paragraph of its own (the caret's paragraph is split around it), as a printout's pages do, so no line is cut by it;
        // the recognised text, when asked for, follows in paragraphs of its own.
        const para = (...inline) => schema.nodes.paragraph.create({id: bid(ctx)}, Fragment.from(inline));
        const blocks = [para(picture)];
        if (p.insertText && text) for (const l of text.split('\n').map(x => x.trim()).filter(Boolean)) blocks.push(para(schema.text(l)));
        const at = insertBlock(ctx, blocks);
        const object = `/pg:${at.pageId}/media:${picture.attrs.id}`;
        ctx.setSelection({ranges: [{anchor: object, focus: object}], primary: 0});
        const placed = {pageId: at.pageId, object};
        return {...placed, ocr, text, alt: picture.attrs.alt, width: picture.attrs.width, height: picture.attrs.height};
      },
    },

    // --- Alternative text -------------------------------------------------------------------------
    {
      id: 'review.setAltText', label: 'Alternative Text', risk: 'edit',
      description: 'Set the alternative text of a picture on the page (what a screen reader says in its place), as the Accessibility Checker\'s fix for a picture with none.',
      params: s.object({id: idParam, alt: s.string({max: 1000}), page: s.optional(s.string({min: 1, max: 80}))}),
      state: pageReady,
      run(ctx, p) {
        const {pageId, hit} = objectOf(ctx, p, 'image');
        if ((hit.node.attrs.alt ?? '') === p.alt) return {changed: false};
        setAttrs(ctx, pageId, hit, {alt: p.alt});
        return {changed: true};
      },
    },
  ],
});
