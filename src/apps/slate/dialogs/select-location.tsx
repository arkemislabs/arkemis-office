// Select Location (Review > Notes > Linked Notes): the file the notes are about, and the notebook's sections and pages to put them
// in, over core/slate/dialogs/select-location.mjs. U:slate/rest.

import {Field, type BodyProps} from './shared';

type Loc = {value: string; label: string; level: number; group?: boolean};

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {locations?: Loc[]; search?: string; location?: string | null; fileName?: string; filePath?: string};
  const q = String(v.search ?? '').trim().toLowerCase();
  const all = v.locations ?? [];
  const shown = q ? all.filter((l, i) => {
    if (l.label.toLowerCase().includes(q)) return true;
    if (l.value.startsWith('page:')) return false;
    for (let k = i + 1; k < all.length && all[k].level > l.level; k++) if (all[k].label.toLowerCase().includes(q)) return true;
    return false;
  }) : all;
  const filled: Record<string, boolean> = {file: !!v.filePath, location: !!v.location};
  const error = (f: string) => (filled[f] ? null : d.errors.find(e => e.field === f)?.message ?? null);
  const pick = async () => {
    const studio = (window as any).studio;
    if (typeof studio?.pickDocument !== 'function') return;
    const f = await studio.pickDocument({all: true, pathOnly: true});
    if (f?.path) { set('filePath', String(f.path)); set('fileName', String(f.name ?? String(f.path).split(/[\\/]/).pop())); }
  };
  return <div className="gd-fields" data-dialog-page="Location">
    <div className="sf-field">
      <label className="sf-label" htmlFor="linked-file">File the notes are about</label>
      <span className="sf-file">
        <input id="linked-file" className="sf-text" readOnly value={v.fileName ?? ''} placeholder="A document on this computer" aria-invalid={!!error('file') || undefined}/>
        <button type="button" className="sf-button" disabled={d.busy} onClick={() => { void pick(); }}>Browse…</button>
      </span>
      {error('file') ? <div className="sf-error" role="alert">{error('file')}</div> : null}
    </div>
    <Field d={d} id="search" set={set} style={{marginTop: 12}}/>
    <div className="sf-list" role="tree" aria-label="All Notebooks" style={{marginTop: 8, height: 170, overflowY: 'auto'}}>
      {shown.length ? shown.map(l => <div key={l.value} role={l.group ? 'group' : 'treeitem'} aria-selected={!l.group && v.location === l.value}
        className={`sf-list-item${v.location === l.value ? ' is-selected' : ''}`} data-location={l.value}
        style={{paddingLeft: 8 + l.level * 16, fontWeight: l.value.startsWith('page:') ? 400 : 600, opacity: l.group ? 0.7 : 1}}
        onClick={() => { if (!l.group) set('location', l.value); }}>{l.label}</div>)
        : <div className="sf-list-empty">{all.length ? 'Nothing matches' : 'This notebook has no sections yet.'}</div>}
    </div>
    {error('location') ? <div className="sf-error" role="alert">{error('location')}</div> : null}
  </div>;
}

export default {Body};
