// Edit Data view (Chart Design › Data › Edit Data): PowerPoint's worksheet (column letters, row numbers, the data-range frame, Add Row, Add
// Series and Switch Row/Column), imported from Prism's view (src/apps/prism/dialogs/chartData.tsx; not edited) over Word's own `rows`
// (core/quill/dialogs/chartData.mjs): the first row names the series (A1 empty), the first column the categories. OK runs chart.editData.

import type {ReactElement} from 'react';
import type {BodyProps} from './font';
import prismData from '../../prism/dialogs/chartData';

const Prism = prismData.Body as unknown as (p: {dialog: any; setValue: (f: string, v: unknown) => void}) => ReactElement; // eslint-disable-line @typescript-eslint/no-explicit-any

function Body({dialog: d, setValue}: BodyProps) {
  const rows = ((d.values.rows as string[][]) ?? [['', 'Series 1'], ['Category 1', '']]);
  const asPrism = {...d, values: {...d.values, table: rows}, errors: d.errors.map(e => (e.field === 'grid' ? {...e, field: 'table'} : e))};
  return <div className="gd-fields" data-dialog-page="Data" data-field-id="grid"><Prism dialog={asPrism} setValue={(_f, v) => setValue('rows', v)}/></div>;
}

export default {Body};
