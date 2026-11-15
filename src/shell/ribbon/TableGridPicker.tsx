// The table size picker (Office: Insert > Table): a grid of cells, ten columns by eight rows;
// hovering lights the cells from the top left to the pointer and names the size, a click inserts
// a table of that size (`insert.table {rows, columns}`). The arrow keys move the highlight and
// Enter inserts, so the picker works without a pointer.

import {useState} from 'react';
import type {SpecControl} from '../../generated/spec-types';
import {toCommandError} from '../../../core/kernel/errors.mjs';
import {useEngine} from '../engine/EngineProvider';
import {useControlState} from '../engine/useCommand';

export const GRID_COLUMNS = 10;
export const GRID_ROWS = 8;

/** True for the control that is the picker itself (the spec's `...table.grid-picker` item). */
export const isTableGridPicker = (c: SpecControl) => c.command === 'insert.table' && /\.grid-picker$/.test(c.id);

export function TableGridPicker({c, onDone}: {c: SpecControl; onDone: () => void}) {
  const {controller} = useEngine();
  const st = useControlState(c);
  const [at, setAt] = useState<{rows: number; columns: number}>({rows: 0, columns: 0});
  const disabled = st.pending || !st.enabled;
  const pick = (rows: number, columns: number) => {
    if (disabled || rows < 1 || columns < 1) return;
    onDone();
    void controller.run('insert.table', {rows, columns}, {origin: 'ui'}).catch(e => controller.notify(toCommandError(e).message, 'error'));
  };
  const move = (dr: number, dc: number) => setAt(p => ({rows: Math.max(1, Math.min(GRID_ROWS, (p.rows || 1) + dr)), columns: Math.max(1, Math.min(GRID_COLUMNS, (p.columns || 1) + dc))}));
  return <div className={`table-grid-picker${disabled ? ' is-disabled' : ''}`} data-control-id={c.id} role="grid" aria-label="Insert Table" tabIndex={0}
    onMouseLeave={() => setAt({rows: 0, columns: 0})}
    onKeyDown={e => {
      if (e.key === 'ArrowRight') { e.preventDefault(); move(0, 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); move(0, -1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); move(1, 0); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1, 0); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(at.rows, at.columns); }
    }}>
    <div className="table-grid-label" aria-live="polite">{at.rows ? `${at.columns} × ${at.rows} Table` : 'Insert Table'}</div>
    <div className="table-grid-cells" style={{gridTemplateColumns: `repeat(${GRID_COLUMNS}, 18px)`}}>
      {Array.from({length: GRID_ROWS * GRID_COLUMNS}, (_, i) => {
        const r = Math.floor(i / GRID_COLUMNS) + 1, col = (i % GRID_COLUMNS) + 1;
        const on = r <= at.rows && col <= at.columns;
        return <button key={i} type="button" role="gridcell" tabIndex={-1} className={`table-grid-cell${on ? ' is-on' : ''}`} aria-label={`${col} columns by ${r} rows`}
          data-rows={r} data-columns={col} onMouseEnter={() => setAt({rows: r, columns: col})} onClick={() => pick(r, col)}/>;
      })}
    </div>
  </div>;
}
