// Table Layout › Table › Properties (submit: table.properties, plus table.altText for the Alt Text
// tab), one undo step.
// Translated from wordcraft crates/ui-egui/src/dialogs/forms.rs (`TableForm` read/changes and
// `table_properties`: Table / Row / Column / Cell, only what changed is sent) at
// aadb077e072b7de05f724e359d8db82e151f125c, with Word's tab arrangement (Table, Row, Column, Cell,
// Alt Text) and inches as the measure. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {gridCol} from '../model/table.mjs';
import * as T from '../lib/table-session.mjs';

const IN = 72;
const r2 = x => Math.round(x * 100) / 100;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export default defineDialog({
  id: 'dialog.tableProperties',
  title: 'Table Properties',
  command: 'table.properties',
  init(ctx) {
    const S = T.open(ctx);
    const [tp, r, c] = T.cell(S);
    const t = S.d.table(S.sel.focus.story, tp);
    const p = t.props ?? {};
    const row = t.rows[r]?.props ?? {};
    const cell = t.rows[r]?.cells[c]?.props ?? {};
    const v = {
      widthOn: typeof p.width === 'number' || typeof p.widthPct === 'number',
      measureIn: typeof p.widthPct === 'number' ? 'percent' : 'inches',
      width: typeof p.widthPct === 'number' ? r2(p.widthPct) : r2((p.width ?? t.grid.reduce((a, x) => a + x, 0)) / IN),
      alignment: p.align ?? 'left',
      indent: r2((p.indent ?? 0) / IN),
      direction: p.bidiVisual ? 'rtl' : 'ltr',
      heightOn: typeof row.height === 'number',
      height: r2((row.height ?? 0) / IN),
      heightRule: row.heightRule === 'exact' ? 'exact' : 'atLeast',
      allowBreak: !row.cantSplit,
      headerRow: !!row.header,
      columnWidth: r2((t.grid[gridCol(t, r, c)] ?? 0) / IN),
      cellWidthOn: typeof cell.width === 'number',
      cellWidth: r2((cell.width ?? t.grid[gridCol(t, r, c)] ?? 0) / IN),
      valign: cell.valign ?? 'top',
      title: p.caption ?? '',
      description: p.description ?? '',
    };
    return {...v, _basis: {...v}};
  },
  validate(v) {
    const out = [];
    const len = (k, lo) => { const x = num(v[k]); if (x === null || x < lo || x > 22) out.push({field: k, message: `The measurement must be between ${lo}" and 22".`}); };
    if (v.widthOn) {
      if (v.measureIn === 'percent') { const x = num(v.width); if (x === null || x < 1 || x > 100) out.push({field: 'width', message: 'The percentage must be between 1 and 100.'}); } else len('width', 0.1);
    }
    if (v.alignment === 'left') { const x = num(v.indent); if (x === null || x < -11 || x > 22) out.push({field: 'indent', message: 'The measurement must be between -11" and 22".'}); }
    if (v.heightOn) len('height', 0.02);
    len('columnWidth', 0.1);
    if (v.cellWidthOn) len('cellWidth', 0.1);
    return out;
  },
  toCommand(v) {
    const b = v._basis ?? {};
    const moved = (x, y) => Math.abs((num(x) ?? 0) - (num(y) ?? 0)) > 0.005;
    const p = {};
    if (v.widthOn !== b.widthOn || v.measureIn !== b.measureIn || (v.widthOn && moved(v.width, b.width))) {
      if (!v.widthOn) p.width = null;
      else if (v.measureIn === 'percent') p.widthPct = num(v.width);
      else p.width = num(v.width) * IN;
    }
    if (v.alignment !== b.alignment) p.align = v.alignment;
    if (v.alignment === 'left' && moved(v.indent, b.indent)) p.indent = num(v.indent) * IN;
    if (v.direction !== b.direction) p.rtl = v.direction === 'rtl';
    if (v.heightOn !== b.heightOn || (v.heightOn && (moved(v.height, b.height) || v.heightRule !== b.heightRule))) {
      p.rowHeight = v.heightOn ? num(v.height) * IN : null;
      p.rowHeightRule = v.heightRule === 'exact' ? 'exact' : 'atLeast';
    }
    if (v.allowBreak !== b.allowBreak) p.allowBreak = !!v.allowBreak;
    if (v.headerRow !== b.headerRow) p.headerRow = !!v.headerRow;
    if (moved(v.columnWidth, b.columnWidth)) p.columnWidth = num(v.columnWidth) * IN;
    if (v.cellWidthOn !== b.cellWidthOn || (v.cellWidthOn && moved(v.cellWidth, b.cellWidth))) p.cellWidth = v.cellWidthOn ? num(v.cellWidth) * IN : null;
    if (v.valign !== b.valign) p.valign = v.valign;
    const steps = [];
    if (Object.keys(p).length) steps.push({command: 'table.properties', params: p});
    if ((v.title ?? '') !== (b.title ?? '') || (v.description ?? '') !== (b.description ?? '')) {
      steps.push({command: 'table.altText', params: {title: v.title ?? '', text: v.description ?? ''}});
    }
    if (!steps.length) return {batch: []};
    return steps.length === 1 ? steps[0] : {batch: steps};
  },
});
