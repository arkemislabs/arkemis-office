// From Text/CSV as Excel draws it: Browse for the file, then a preview of its first rows with the delimiter (detected unless you pick one) and Load.
// The file is read by the app's own picker (`studio.pickDocument`, which returns its bytes); the text is decoded as File > Open decodes a CSV and
// kept in the dialog's values. Over gridcraft's get_data (cmd/extra/data.rs) at 146161b4b450a56e5e59a083ba0478582d1e602b. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {useMemo} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {decodeText} from '../../../../core/grid/formats/csv-read.mjs';
import {delimiterOf, rowsOfText} from '../../../../core/grid/commands/data/import.mjs';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Btn, Fld, type SetValue} from './dataKit';

const ROWS = 14, COLS = 8;

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller} = useEngine();
  const text = String(d.values.text ?? '');
  const delimiter = String(d.values.delimiter ?? '');
  const browse = async () => {
    try {
      const studio = (window as any).studio;
      const doc = typeof studio?.pickDocument === 'function' ? await studio.pickDocument({purpose: 'recipients'}) : null;
      if (!doc) return;
      if (!['csv', 'tsv', 'txt', 'json'].includes(String(doc.format))) throw new Error('Choose a text, CSV or JSON file. Excel workbooks open with File > Open.');
      const bin = atob(String(doc.data));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      setValue('name', String(doc.name));
      setValue('text', decodeText(bytes));
    } catch (e) { controller.notify(toCommandError(e).message, 'error'); }
  };
  const shown = useMemo(() => {
    if (!text) return {rows: [] as string[][], delim: ''};
    try {
      const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      const delim = t.trim().startsWith('[') ? ',' : delimiterOf(delimiter, t);
      return {rows: rowsOfText(t, delim, ROWS), delim};
    } catch { return {rows: [] as string[][], delim: ''}; }
  }, [text, delimiter]);
  const width = Math.min(COLS, Math.max(0, ...shown.rows.map(r => r.length)));
  const error = d.errors.find(e => e.field === 'text')?.message ?? null;
  return <div className="gd-fields">
    <div className="data-row">
      <Btn onClick={() => void browse()} label="Browse for a file">Browse{'…'}</Btn>
      <span className="sf-label" data-field-id="name">{d.values.name ? String(d.values.name) : 'No file chosen'}</span>
    </div>
    <div className="data-two">
      <dl className="data-facts" style={{margin: 0}}><dt>File Origin</dt><dd>{text ? '65001: Unicode (UTF-8)' : ''}</dd></dl>
      <Fld d={d} set={setValue} id="delimiter" kind="select" label="Delimiter" options={[{value: '', label: 'Detect'}, {value: 'comma', label: 'Comma'}, {value: 'semicolon', label: 'Semicolon'}, {value: 'tab', label: 'Tab'}, {value: 'space', label: 'Space'}, {value: 'colon', label: 'Colon'}, {value: 'pipe', label: 'Pipe'}]}/>
    </div>
    <div className="data-preview" role="region" aria-label="Preview" data-field-id="text">
      {shown.rows.length ? <table><tbody>{shown.rows.map((r, i) => <tr key={i}>{Array.from({length: width}, (_, c) => i === 0 ? <th key={c}>{r[c] ?? ''}</th> : <td key={c}>{r[c] ?? ''}</td>)}</tr>)}</tbody></table>
        : <p className="sf-note" style={{margin: 8}}>Choose a file to see its first rows.</p>}
    </div>
    {error ? <small className="sf-error" role="alert">{error}</small> : null}
  </div>;
}

export default {Body};
