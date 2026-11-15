// Sort view (Table Layout › Data › Sort): Sort by lists the table's columns (its header texts when
// the list has a header row, else Column n), Ascending / Descending beside it, My list has below,
// over core/quill/dialogs/tableSort.mjs (wordcraft dialogs_layout/table.rs `sort_ui`).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, Group, grid, type BodyProps} from './font';
import {columnOptions} from '../../../../core/quill/dialogs/tableSort.mjs';

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {headers?: string[]; header?: string};
  const options = columnOptions(v.headers ?? [], v.header === 'yes');
  return <div className="gd-fields">
    <Group title="Sort by">
      <div style={grid('minmax(0, 1.4fr) minmax(0, 1fr)')}><Field d={d} id="column" set={set} options={options}/><Field d={d} id="order" set={set}/></div>
    </Group>
    <Field d={d} id="header" set={set}/>
  </div>;
}

export default {Body};
