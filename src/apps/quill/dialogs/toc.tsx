// Table of Contents view (References › Table of Contents › Custom Table of Contents…): Word's Print
// Preview of the levels with their leader and page numbers, Show page numbers, Right align page
// numbers, Tab leader, hyperlinks, Show levels, and the Options… section (Build table of contents
// from: Styles with each style's TOC level, Outline levels, Table entry fields), over
// core/quill/dialogs/toc.mjs. Layout from wordcraft crates/ui-egui/src/dialogs/dialogs_refs/toc.rs
// (`toc_ui`, `toc_options_ui`) and common.rs (`sample`) at aadb077e072b7de05f724e359d8db82e151f125c.
// Also exports the sample picture the Table of Figures and Index views draw.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useState} from 'react';
import {Field, Group, grid, type BodyProps} from './font';

const LEADER_CHAR: Record<string, string> = {dot: '.', hyphen: '-', underscore: '_'};

/** Word's preview box: lines [indent level, text, page] with the leader up to a right-aligned page (common.rs `sample`). */
export function Sample({lines, right, leader, label = 'Print Preview', width = 260}: {lines: [number, string, string][]; right: boolean; leader: string; label?: string; width?: number}) {
  const row = 17, h = row * Math.max(1, lines.length) + 10;
  const ch = right ? LEADER_CHAR[leader] ?? '' : '';
  return <div className="sf" data-field-id="preview" style={{marginBottom: 10}}>
    <div className="sf-label" style={{marginBottom: 4}}>{label}</div>
    <svg role="img" aria-label={label} width={width} height={h} viewBox={`0 0 ${width} ${h}`} style={{display: 'block', background: '#fff', border: '1px solid var(--gd-border, #c9c9cf)', borderRadius: 2}}>
      {lines.map(([level, text, page], i) => {
        const y = 5 + row * i + 12;
        const x = 8 + 12 * level;
        const tw = text.length * 5.6;
        const px = right ? width - 8 : x + tw + 4;
        return <g key={i} fontFamily="Segoe UI, sans-serif" fontSize={11} fill="#000">
          <text x={x} y={y}>{text}</text>
          {page ? <text x={px} y={y} textAnchor={right ? 'end' : 'start'}>{page}</text> : null}
          {page && ch && px - page.length * 6.5 - 4 > x + tw + 6 ? <line x1={x + tw + 4} x2={px - page.length * 6.5 - 4} y1={ch === '_' ? y + 1 : ch === '-' ? y - 3.5 : y - 0.5}
            y2={ch === '_' ? y + 1 : ch === '-' ? y - 3.5 : y - 0.5} stroke="#5a5a5a" strokeWidth={ch === '.' ? 1.2 : 1}
            strokeDasharray={ch === '.' ? '0.01 3' : ch === '-' ? '3 2' : undefined} strokeLinecap={ch === '.' ? 'round' : 'butt'}/> : null}
        </g>;
      })}
    </svg>
  </div>;
}

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {pageNumbers?: boolean; rightAlign?: boolean; tabLeader?: string; levels?: number; styleLevels?: [string, number][]};
  const [options, setOptions] = useState(false);
  const levels = Math.max(1, Math.min(9, Number(v.levels) || 3));
  const lines: [number, string, string][] = [];
  for (let l = 1; l <= Math.min(levels, 3); l++) lines.push([l - 1, `Heading ${l}`, v.pageNumbers ? String(l * 2 - 1) : '']);
  const styles = Array.isArray(v.styleLevels) ? v.styleLevels : [];
  return <div className="gd-fields" data-dialog-page="Table of Contents">
    <div style={grid('minmax(0, 1fr) minmax(0, 1fr)', {alignItems: 'start'})}>
      <Sample lines={lines} right={!!v.rightAlign} leader={v.tabLeader ?? 'dot'}/>
      <div>
        <Field d={d} id="pageNumbers" set={set}/>
        <Field d={d} id="rightAlign" set={set}/>
        <div style={{marginTop: 6}}><Field d={d} id="tabLeader" set={set}/></div>
      </div>
    </div>
    <Field d={d} id="hyperlinks" set={set}/>
    <Group title="General" style={{marginTop: 10}}>
      <div style={grid('140px 1fr')}><Field d={d} id="levels" set={set}/>
        <button type="button" className="sf-button" aria-expanded={options} data-field-id="options" onClick={() => setOptions(o => !o)} style={{justifySelf: 'end'}}>Options…</button></div>
    </Group>
    {options ? <Group title="Build table of contents from">
      <Field d={d} id="headingStyles" set={set}/>
      <div role="table" aria-label="Available styles" style={{maxHeight: 150, overflow: 'auto', border: '1px solid var(--gd-border, #c9c9cf)', borderRadius: 4, margin: '6px 0'}}>
        {styles.map(([name, level], i) => <div key={name} role="row" style={{display: 'grid', gridTemplateColumns: '1fr 64px', alignItems: 'center', padding: '2px 8px', fontSize: 12.5}}>
          <span role="cell">{name}</span>
          <input role="cell" aria-label={`TOC level of ${name}`} className="sf-text" type="number" min={0} max={9} value={level ? String(level) : ''}
            onChange={e => { const next = styles.map((x, k) => (k === i ? [x[0], Math.max(0, Math.min(9, Number(e.target.value) || 0))] : x)); set('styleLevels', next); }}/>
        </div>)}
      </div>
      <div style={grid('1fr 1fr')}><Field d={d} id="outlineLevels" set={set}/><Field d={d} id="tcFields" set={set}/></div>
    </Group> : null}
  </div>;
}

export default {Body};
