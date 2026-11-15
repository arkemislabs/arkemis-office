// Edit Data: the chart's data as a worksheet (column letters, row numbers, the cells), first row series names, first
// column categories, with the data range, Switch Row/Column and the add-a-row and add-a-series buttons deckcraft's
// dialog has (crates/ui-egui/src/dialogs/body.rs `dlg_chart_data`). The grid always draws at least 8 rows and 6 columns, as
// the worksheet does; cells beyond the data are empty and become part of the chart once typed in.

import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Icon} from '../../../shell/icons/Icon';
import '../surface/chart.css';

const letter = (c: number) => String.fromCharCode(65 + c);
const MIN_ROWS = 8, MIN_COLS = 6;

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: (field: string, value: unknown) => void}) {
  const table: string[][] = Array.isArray(d.values.table) ? (d.values.table as string[][]) : [];
  const dataRows = table.length, dataCols = Math.max(2, ...table.map(r => r.length));
  const rows = Math.max(MIN_ROWS, dataRows), cols = Math.max(MIN_COLS, dataCols);
  const cell = (r: number, c: number) => table[r]?.[c] ?? '';
  const set = (r: number, c: number, v: string) => {
    const next = Array.from({length: Math.max(dataRows, r + 1)}, (_, i) => Array.from({length: Math.max(dataCols, c + 1)}, (_, j) => table[i]?.[j] ?? ''));
    next[r][c] = v;
    // Trailing empty rows and columns are not data.
    while (next.length > 2 && next[next.length - 1].every(x => x === '')) next.pop();
    setValue('table', next);
  };
  const addRow = () => setValue('table', [...table.map(r => r.slice()), Array(dataCols).fill('')]);
  const addSeries = () => setValue('table', table.map((r, i) => [...r, ...Array(dataCols - r.length).fill(''), i === 0 ? `Series ${dataCols}` : '']));
  const switchRC = () => {
    const out = Array.from({length: dataCols}, (_, c) => Array.from({length: dataRows}, (_, r) => cell(r, c)));
    setValue('table', out);
  };
  const error = d.errors.find(e => e.field === 'table')?.message ?? null;
  return <div className="chd" data-field-id="table">
    <div className="chd-range"><span>Chart data range</span><output>{`=Sheet1!$A$1:$${letter(dataCols - 1)}$${dataRows}`}</output></div>
    <div className="chd-scroll"><table><thead><tr><th className="chd-corner"/>{Array.from({length: cols}, (_, c) => <th key={c} className="chd-col">{letter(c)}</th>)}</tr></thead><tbody>
      {Array.from({length: rows}, (_, r) => <tr key={r}><th className="chd-row">{r + 1}</th>{Array.from({length: cols}, (_, c) => {
        const inData = r < dataRows && c < dataCols;
        const label = r === 0 ? (c === 0 ? 'Corner cell' : `Series ${c} name`) : c === 0 ? `Category ${r}` : `Row ${r}, column ${c}`;
        return <td key={c} className={`${inData ? 'is-data' : ''}${r === 0 || c === 0 ? ' is-head' : ''}`}>
          <input value={cell(r, c)} aria-label={`${letter(c)}${r + 1}: ${label}`} onChange={e => set(r, c, e.target.value)}/></td>;
      })}</tr>)}
    </tbody></table></div>
    <div className="chd-help">The first row names the series, the first column the categories. The blue frame is what the chart plots.</div>
    <div className="chd-bar">
      <button type="button" className="sf-button" title="Add a row" aria-label="Add a row" onClick={addRow}><Icon id="row-insert-below" size={16}/> Add Row</button>
      <button type="button" className="sf-button" title="Add a series" aria-label="Add a series" onClick={addSeries}><Icon id="table-col-right" size={16}/> Add Series</button>
      <button type="button" className="sf-button" title="Switch Row/Column" aria-label="Switch Row/Column" onClick={switchRC}><Icon id="switch-row-column" size={16}/> Switch Row/Column</button>
    </div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

export default {Body};
