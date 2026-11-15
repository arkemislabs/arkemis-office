// Diagram (double-click a diagram, or select it and choose Edit): the kind, chosen from drawn thumbnails, and the outline, over
// core/slate/dialogs/diagram.mjs. U:slate/rest.

import {type BodyProps} from './shared';

const KINDS = ['flowchart', 'hierarchy', 'process', 'cycle'] as const;
const LABEL: Record<string, string> = {flowchart: 'Flowchart', hierarchy: 'Hierarchy', process: 'Process', cycle: 'Cycle'};
const HINT: Record<string, string> = {
  flowchart: '(Start) is a rounded box, <Is it done?> is a diamond; the lines run top to bottom.',
  hierarchy: 'Indent a line (two spaces) to hang it under the line above.',
  process: 'The lines run left to right.',
  cycle: 'The lines go round a circle, the last back to the first.',
};

/** A small drawing of what each kind makes (boxes and the lines between them). */
function Thumb({kind}: {kind: string}) {
  const box = {fill: 'currentColor', fillOpacity: 0.16, stroke: 'currentColor', strokeWidth: 1.3} as const;
  const line = {fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round'} as const;
  return <svg viewBox="0 0 72 52" width="72" height="52" aria-hidden="true" focusable="false">
    {kind === 'flowchart' ? <>
      <rect x="24" y="2" width="24" height="9" rx="4.5" {...box}/><path d="M36 11v4" {...line}/>
      <rect x="24" y="15" width="24" height="9" rx="1.5" {...box}/><path d="M36 24v4" {...line}/>
      <path d="M36 28l9 6-9 6-9-6z" {...box}/><path d="M36 40v3" {...line}/>
      <rect x="24" y="43" width="24" height="7" rx="3.5" {...box}/></> : null}
    {kind === 'hierarchy' ? <>
      <rect x="26" y="3" width="20" height="9" rx="1.5" {...box}/><path d="M36 12v6M14 18h44M14 18v6M36 18v6M58 18v6" {...line}/>
      <rect x="5" y="24" width="18" height="9" rx="1.5" {...box}/><rect x="27" y="24" width="18" height="9" rx="1.5" {...box}/><rect x="49" y="24" width="18" height="9" rx="1.5" {...box}/>
      <path d="M14 33v5M8 38h12M8 38v4M20 38v4" {...line}/>
      <rect x="2" y="42" width="12" height="8" rx="1.5" {...box}/><rect x="16" y="42" width="12" height="8" rx="1.5" {...box}/></> : null}
    {kind === 'process' ? <>
      <rect x="2" y="19" width="14" height="14" rx="1.5" {...box}/><path d="M16 26h6M20 24l2 2-2 2" {...line}/>
      <rect x="22" y="19" width="14" height="14" rx="1.5" {...box}/><path d="M36 26h6M40 24l2 2-2 2" {...line}/>
      <rect x="42" y="19" width="14" height="14" rx="1.5" {...box}/><path d="M56 26h4M58 24l2 2-2 2" {...line}/>
      <rect x="60" y="19" width="10" height="14" rx="1.5" {...box}/></> : null}
    {kind === 'cycle' ? <>
      <rect x="26" y="2" width="20" height="10" rx="1.5" {...box}/><rect x="48" y="21" width="20" height="10" rx="1.5" {...box}/>
      <rect x="26" y="40" width="20" height="10" rx="1.5" {...box}/><rect x="4" y="21" width="20" height="10" rx="1.5" {...box}/>
      <path d="M50 7c8 1 14 6 16 12M64 17l2 3 3-3M62 36c-3 7-9 11-15 12M49 46l-3 2 3 3M22 45c-8-2-14-7-16-14M8 33l-1-3-3 2M10 17c2-6 8-10 15-11M23 4l3 2-3 3" {...line}/></> : null}
  </svg>;
}

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {kind?: string; text?: string};
  const kind = String(v.kind ?? 'flowchart');
  const error = d.errors.find(e => e.field === 'text')?.message ?? null;
  return <div className="gd-fields" data-dialog-page="Diagram">
    <div className="sf-field">
      <span className="sf-label" id="diagram-kind-label">Kind</span>
      <div role="radiogroup" aria-labelledby="diagram-kind-label" style={{display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 4}}>
        {KINDS.map(k => <button key={k} type="button" role="radio" aria-checked={kind === k} aria-label={LABEL[k]} data-kind={k} disabled={d.busy} onClick={() => set('kind', k)}
          style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 4px 6px', borderRadius: 8, cursor: 'pointer', font: 'inherit', color: kind === k ? '#8fb4ff' : 'inherit',
            background: kind === k ? 'rgba(122, 159, 220, .16)' : 'transparent', border: `1px solid ${kind === k ? '#7a9fdc' : 'rgba(255,255,255,.16)'}`}}>
          <Thumb kind={k}/><span style={{fontSize: 12, color: 'inherit'}}>{LABEL[k]}</span></button>)}
      </div>
    </div>
    <div className="sf-field" style={{marginTop: 12}}>
      <label className="sf-label" htmlFor="diagram-outline">Outline (one box to a line)</label>
      <textarea id="diagram-outline" className="sf-textarea" rows={9} value={v.text ?? ''} spellCheck={false} disabled={d.busy} aria-invalid={!!error || undefined}
        onChange={e => set('text', e.target.value)} style={{width: '100%', boxSizing: 'border-box', fontFamily: 'Consolas, "Cascadia Mono", monospace', whiteSpace: 'pre', resize: 'vertical'}}/>
      {error ? <div className="sf-error" role="alert">{error}</div> : null}
    </div>
    <p style={{margin: '8px 0 0', fontSize: 12, opacity: 0.75}}>{HINT[kind]}</p>
  </div>;
}

export default {Body};
