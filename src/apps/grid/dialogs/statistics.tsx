// Workbook Statistics as Excel draws it: two columns of numbers, the current sheet and the workbook.
// The counts are gridcraft's `review.workbookStatistics` (crates/engine/src/cmd/review.rs `stats`) at fb1e59f.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {DialogState} from '../../../shell/dialogs/dialogState';

type Stats = {
  sheet: {name: string; endOfSheet: string | null; cellsWithData: number; tables: number; formulas: number; charts: number; comments: number};
  workbook: {sheets: number; cellsWithData: number; tables: number; charts: number; names: number};
};

function Body({dialog: d}: {dialog: DialogState; setValue: (f: string, v: unknown) => void}) {
  const r = d.values.result as Stats | undefined;
  if (!r) return <div className="gd-fields"><p>No workbook is open.</p></div>;
  const n = (v: number) => v.toLocaleString();
  return <div className="gd-fields">
    <div className="sf" data-field-id="currentSheet" data-kind="list">
      <span className="sf-label">Current sheet: {r.sheet.name}</span>
      <dl className="data-facts">
        <dt>End of sheet</dt><dd>{r.sheet.endOfSheet ?? 'Empty'}</dd>
        <dt>Cells with data</dt><dd>{n(r.sheet.cellsWithData)}</dd>
        <dt>Formulas</dt><dd>{n(r.sheet.formulas)}</dd>
        <dt>Tables</dt><dd>{n(r.sheet.tables)}</dd>
        <dt>Charts</dt><dd>{n(r.sheet.charts)}</dd>
        <dt>Comments and notes</dt><dd>{n(r.sheet.comments)}</dd>
      </dl>
    </div>
    <div className="sf" data-field-id="workbook" data-kind="list">
      <span className="sf-label">Workbook</span>
      <dl className="data-facts">
        <dt>Sheets</dt><dd>{n(r.workbook.sheets)}</dd>
        <dt>Cells with data</dt><dd>{n(r.workbook.cellsWithData)}</dd>
        <dt>Tables</dt><dd>{n(r.workbook.tables)}</dd>
        <dt>Charts</dt><dd>{n(r.workbook.charts)}</dd>
        <dt>Names</dt><dd>{n(r.workbook.names)}</dd>
      </dl>
    </div>
  </div>;
}

export default {Body};
