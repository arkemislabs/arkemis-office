// Define New Multilevel List view (Home › Paragraph › Multilevel List › Define New Multilevel
// List…): the level list beside the nine-level preview, Number format (formatting, font, style,
// include level, start, restart, link to style, legal) and Position (alignment, aligned at, text
// indent, follow with, tab stop), over core/quill/dialogs/defineList.mjs.
// Translated from wordcraft crates/ui-egui/src/dialogs/dialogs_lists.rs `define_list` and
// `preview` at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {Field, Group, grid, usePreview, useStyleOptions, type BodyProps} from './font';

type Row = {label: string; align: string; alignedAt: number; indentAt: number; follow: string};

/** All nine levels, each number at its aligned-at position and a grey text bar at its indent (`preview`). */
function ListPreview({rows, current}: {rows: Row[]; current: number}) {
  const W = 300, row = 19, pad = 8;
  const scale = (W - 16) / 324;
  const x = (pt: number) => pad + Math.max(0, Math.min(W - 40, pt * scale));
  return <div className="sf" data-field-id="preview" data-kind="preview">
    <span className="sf-label">Preview</span>
    <svg role="img" aria-label="List preview" viewBox={`0 0 ${W} ${row * 9 + 8}`} style={{width: '100%', borderRadius: 8, background: '#fff', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.25)'}}>
      {rows.map((r, i) => {
        const y = 4 + row * i + row / 2;
        const on = i === current;
        const ink = on ? '#111' : '#969696';
        const w = r.label.length * 5.6;
        const ax = x(r.alignedAt);
        const nx = r.align === 'center' ? ax - w / 2 : r.align === 'right' ? ax - w : ax;
        const tx = r.follow === 'space' ? nx + w + 3 : r.follow === 'nothing' ? nx + w : Math.max(x(r.indentAt), nx + w + 2);
        return <g key={i}>
          <text x={nx} y={y} dominantBaseline="central" fontSize={10.5} fill={ink} fontFamily="Aptos, Segoe UI, sans-serif">{r.label}</text>
          {W - pad - tx > 0 ? <rect x={tx} y={y - 2} width={W - pad - tx} height={4} rx={1} fill={on ? '#787878' : '#cdcdcd'}/> : null}
        </g>;
      })}
    </svg>
  </div>;
}

function Body({dialog: d, setValue: set}: BodyProps) {
  const p = usePreview(d) ?? {};
  const styles = useStyleOptions(['paragraph'], '(no style)');
  const level = Number(d.values.level ?? 0);
  return <div className="gd-fields">
    <div style={grid('72px minmax(0, 1fr)', {alignItems: 'start', marginBottom: 12})}>
      <div className="sf" data-field-id="level" data-kind="list">
        <span className="sf-label">Click level to modify:</span>
        <div className="sf-list" role="listbox" aria-label="Level" style={{height: 180}}>
          {Array.from({length: 9}, (_, i) => <div key={i} role="option" aria-selected={i === level} className={`sf-list-item${i === level ? ' is-selected' : ''}`}
            onClick={() => set('level', i)}>{i + 1}</div>)}
        </div>
      </div>
      <ListPreview rows={(Array.isArray(p.rows) ? p.rows : []) as Row[]} current={level}/>
    </div>
    <Group title="Number format">
      <div style={grid('minmax(0, 1.6fr) minmax(0, 1fr)')}>
        <Field d={d} id="text" set={set}/>
        <Field d={d} id="font" set={set} override="combo"/>
      </div>
      <div style={grid('repeat(2, max-content)', {gap: '6px 18px', marginTop: 8})}><Field d={d} id="bold" set={set}/><Field d={d} id="italic" set={set}/></div>
      <div style={grid('minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, .6fr)', {marginTop: 10})}>
        <Field d={d} id="format" set={set}/>
        <Field d={d} id="includeLevel" set={set}/>
        <Field d={d} id="start" set={set}/>
      </div>
      <div style={grid('minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr)', {marginTop: 10})}>
        <Field d={d} id="restart" set={set}/>
        <Field d={d} id="restartAfter" set={set}/>
        <Field d={d} id="linkStyle" set={set} options={styles}/>
      </div>
      <div style={{marginTop: 8}}><Field d={d} id="legal" set={set}/></div>
    </Group>
    <Group title="Position">
      <div style={grid('repeat(3, minmax(0, 1fr))')}>
        <Field d={d} id="align" set={set}/><Field d={d} id="alignedAt" set={set}/><Field d={d} id="indentAt" set={set}/>
      </div>
      <div style={grid('minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', {marginTop: 10})}>
        <Field d={d} id="follow" set={set}/><Field d={d} id="tabOn" set={set}/><Field d={d} id="tabAt" set={set}/>
      </div>
    </Group>
  </div>;
}

export default {Body};
