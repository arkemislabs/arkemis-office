// Create New Style from Formatting view (Table Design › Table Styles › New Table Style…) and, through
// modifyTableStyle.tsx, Modify Style: name and base, the part to format, its font, borders, fill
// and alignment, over a sample table, over core/quill/lib/table_style-form.mjs (wordcraft
// dialogs_table_style.rs). MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, Group, grid, type BodyProps} from './font';
import {formOptions} from '../../../../core/quill/lib/table_style-form.mjs';

/** The Font and Size boxes' lists (the form keeps the style's own font and size until one is picked here). */
// The empty font and size mean the style's own; the boxes show them under these names (sentinels the form never sees).
const STYLE_FONT = '(Style font)', STYLE_SIZE = '(Style size)', NO_EDGE = '(choose)', NO_BASE = '(no style)';
const FONT_CHOICES = [STYLE_FONT, ...['Aptos', 'Arial', 'Calibri', 'Cambria', 'Courier New', 'Georgia', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana']].map(f => ({value: f, label: f}));
const SIZE_CHOICES = [STYLE_SIZE, ...[8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72].map(String)].map(n => ({value: n, label: n}));

type Region = {fill: string; bold: boolean; italic: boolean; color: string};

/** The form's preview: a 5 × 5 sample table with the whole table, header row and banded rows' formatting. */
function Sample({v}: {v: Record<string, unknown>}) {
  const regions = (v.regions ?? []) as Region[];
  const blank: Region = {fill: '', bold: false, italic: false, color: ''};
  const pick = (r: number) => (r === 0 && regions[1]?.fill ? regions[1] : r % 2 === 1 && regions[5]?.fill ? regions[5] : regions[0]) ?? blank;
  const rows = [['', 'Jan', 'Feb', 'Mar', 'Total'], ['East', '7', '7', '5', '19'], ['West', '6', '4', '7', '17'], ['South', '8', '7', '9', '24'], ['Total', '21', '18', '21', '60']];
  return <table aria-label="Preview" style={{borderCollapse: 'collapse', background: '#fff', color: '#1b1b1d', fontSize: 11, width: '100%'}}><tbody>
    {rows.map((row, r) => <tr key={r}>{row.map((cell, c) => {
      const p = pick(r);
      return <td key={c} style={{border: '1px solid #9a9a9a', padding: '3px 6px', background: p.fill ? `#${p.fill}` : undefined,
        fontWeight: p.bold ? 700 : 400, fontStyle: p.italic ? 'italic' : 'normal', color: p.color ? `#${p.color}` : undefined}}>{cell}</td>;
    })}</tr>)}
  </tbody></table>;
}

export function StyleBody({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as Record<string, unknown> & {basedOnOptions?: {value: string; label: string}[]};
  // Font, Size and Borders as they read in the boxes: the style's own, and the pick-an-edge prompt.
  const shown = {...d, values: {...d.values, font: v.font || STYLE_FONT, size: v.size || STYLE_SIZE, borders: v.borders || NO_EDGE, basedOn: v.basedOn || NO_BASE}};
  const put: BodyProps['setValue'] = (id, value) => set(id, id === 'font' ? (value === STYLE_FONT ? '' : value) : id === 'size' ? (value === STYLE_SIZE ? '' : value) : id === 'borders' ? (value === NO_EDGE ? null : value) : id === 'basedOn' ? (value === NO_BASE ? '' : value) : value);
  const edges = [{value: NO_EDGE, label: 'Choose borders…'}, ...(formOptions.borders as {value: string; label: string}[])];
  return <div className="gd-fields">
    <Group title="Properties">
      <div style={grid('minmax(0, 1fr) minmax(0, 1fr)')}>
        <Field d={d} id="name" set={set}/>
        <Field d={shown} id="basedOn" set={put} options={[...(v.basedOnOptions ?? []), ...((v.basedOnOptions ?? []).some(o => o.value === '') ? [] : [{value: NO_BASE, label: NO_BASE}])]}/>
      </div>
    </Group>
    <Group title="Formatting">
      <Field d={d} id="region" set={set} options={formOptions.region}/>
      <div style={grid('minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr)', {marginTop: 8})}>
        <Field d={shown} id="font" set={put} options={FONT_CHOICES}/><Field d={shown} id="size" set={put} override="select" options={SIZE_CHOICES}/><Field d={d} id="fontColor" set={set}/>
      </div>
      <div style={{display: 'flex', gap: 22, marginTop: 8}}><Field d={d} id="bold" set={set}/><Field d={d} id="italic" set={set}/><Field d={d} id="underline" set={set}/></div>
      <div style={grid('repeat(3, minmax(0, 1fr))', {marginTop: 8})}>
        <Field d={d} id="borderStyle" set={set}/><Field d={d} id="borderWidth" set={set}/><Field d={d} id="borderColor" set={set}/>
        <Field d={shown} id="borders" set={put} options={edges}/><Field d={d} id="fill" set={set}/>
      </div>
      <div style={{marginTop: 8}}><Field d={d} id="alignment" set={set} options={formOptions.alignment}/></div>
      <div style={{marginTop: 10}}><Sample v={v}/></div>
    </Group>
  </div>;
}

export default {Body: StyleBody};
