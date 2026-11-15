// Table Properties view (Table Layout › Table › Properties): Word's pages. Table: Size (Preferred width and its measure), Alignment as drawn tiles with
// the indent, Table direction, Options…; Row: Size and Options; Column; Cell: Size, Vertical alignment as drawn tiles, Options…; Alt Text. Over
// core/quill/dialogs/tableProperties.mjs (wordcraft forms.rs `TableForm`). Text wrapping Around needs floating tables, which the layout does not
// have, and Borders and Shading is the Table Design tab's: neither is drawn. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, Group, PageTabs, grid, type BodyProps} from './font';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';

const tile = (on: boolean) => ({width: 52, height: 46, padding: 0, display: 'grid', placeItems: 'center', ...(on ? {outline: '2px solid #5b9bd5', outlineOffset: -2, background: 'rgba(91,155,213,.22)'} : {})}) as const;

/** A row of icon tiles for a choice: each draws the choice (a table at the left, centred or at the right; text at the top, middle or bottom of a cell). */
function Tiles({d, id, label, items, set}: {d: BodyProps['dialog']; id: string; label: string; items: [string, string, React.ReactElement][]; set: BodyProps['setValue']}) {
  const cur = d.values[id];
  return <div className="sf" data-field-id={id} role="radiogroup" aria-label={label}>
    <span className="sf-label">{label}</span>
    <div style={{display: 'flex', gap: 6, marginTop: 4}}>
      {items.map(([value, name, art]) => <button key={value} type="button" role="radio" aria-checked={cur === value} aria-label={name} title={name} className={`sf-button${cur === value ? ' is-selected' : ''}`}
        style={tile(cur === value)} onClick={() => set(id, value)}><svg width="40" height="34" viewBox="0 0 40 34" aria-hidden="true">{art}</svg></button>)}
    </div>
  </div>;
}
const page = <rect x="3" y="2" width="34" height="30" fill="none" stroke="currentColor" strokeWidth="1" opacity=".5"/>;
const tbl = (x: number) => <g fill="none" stroke="currentColor" strokeWidth="1.4"><rect x={x} y="10" width="16" height="14"/><path d={`M${x + 8} 10v14M${x} 17h16`}/></g>;
const lines = (x: number, y: number, w = 10) => <path d={`M${x} ${y}h${w}M${x} ${y + 4}h${w - 2}`} stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity=".7"/>;
const ALIGN: [string, string, React.ReactElement][] = [['left', 'Left', <>{page}{tbl(6)}</>], ['center', 'Center', <>{page}{tbl(12)}</>], ['right', 'Right', <>{page}{tbl(18)}</>]];
const cell = (y: number) => <><rect x="6" y="3" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d={`M11 ${y}h18M11 ${y + 4}h14`} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></>;
const VALIGN: [string, string, React.ReactElement][] = [['top', 'Top', cell(7)], ['center', 'Center', cell(14)], ['bottom', 'Bottom', cell(21)]];

function Body({dialog: d, setValue: set}: BodyProps) {
  const {controller} = useEngine();
  const press = (id: string) => { void controller.pressField(d.key, id).catch(e => controller.notify(toCommandError(e).message, 'error')); };
  const name = d.spec.tabs[d.tab]?.name ?? 'Table';
  const row2 = (...ids: string[]) => <div style={grid(`repeat(${ids.length}, minmax(0, 1fr))`)}>{ids.map(i => <Field key={i} d={d} id={i} set={set}/>)}</div>;
  const options = (id: string) => <div style={{display: 'flex', justifyContent: 'flex-end', marginTop: 12}}><button type="button" className="sf-button" onClick={() => press(id)}>Options…</button></div>;
  return <div className="gd-fields" data-dialog-page={name}>
    <PageTabs dialog={d}/>
    {name === 'Table' ? <>
      <Group title="Size">
        <div style={grid('auto minmax(0, 1fr) minmax(0, 1fr)')}><Field d={d} id="widthOn" set={set}/><Field d={d} id="width" set={set}/><Field d={d} id="measureIn" set={set}/></div>
      </Group>
      <Group title="Alignment">
        <div style={grid('auto minmax(0, 1fr)', {alignItems: 'end', gap: '10px 24px'})}>
          <Tiles d={d} id="alignment" label="Alignment" items={ALIGN} set={set}/>
          <Field d={d} id="indent" set={set}/>
        </div>
      </Group>
      <Group title="Direction"><Field d={d} id="direction" set={set}/></Group>
      {options('options')}
    </> : null}
    {name === 'Row' ? <>
      <Group title="Size">{row2('heightOn', 'height', 'heightRule')}</Group>
      <Group title="Options"><div style={{display: 'grid', gap: 8}}><Field d={d} id="allowBreak" set={set}/><Field d={d} id="headerRow" set={set}/></div></Group>
    </> : null}
    {name === 'Column' ? <Group title="Size"><Field d={d} id="columnWidth" set={set}/></Group> : null}
    {name === 'Cell' ? <>
      <Group title="Size">{row2('cellWidthOn', 'cellWidth')}</Group>
      <Group title="Vertical alignment"><Tiles d={d} id="valign" label="Vertical alignment" items={VALIGN} set={set}/></Group>
      {options('cellOptions')}
    </> : null}
    {name === 'Alt Text' ? <><Field d={d} id="title" set={set}/><div style={{marginTop: 10}}><Field d={d} id="description" set={set}/></div></> : null}
  </div>;
}

export default {Body};
