// Link view (Insert > Links > Link, Ctrl+K): Text to display and Address, then "Or pick a location
// in OneNote": a search box over the notebook's sections and pages (sections in their groups,
// pages indented under their section, subpages further) and "Create a new page with this title",
// over core/slate/dialogs/link.mjs. Slate has no ArtCraft upstream.

import {Field, grid, type BodyProps} from './shared';

type Loc = {value: string; label: string; level: number; group?: boolean};

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {locations?: Loc[]; search?: string; location?: string | null; createNewPage?: boolean};
  const q = String(v.search ?? '').trim().toLowerCase();
  const all = v.locations ?? [];
  // A section stays in the list when it or one of its pages matches; a page only when it matches.
  const shown = q ? all.filter((l, i) => {
    if (l.label.toLowerCase().includes(q)) return true;
    if (l.value.startsWith('page:')) return false;
    for (let k = i + 1; k < all.length && all[k].level > l.level; k++) if (all[k].label.toLowerCase().includes(q)) return true;
    return false;
  }) : all;
  return <div className="gd-fields" data-dialog-page="Link">
    <Field d={d} id="textToDisplay" set={set}/>
    <Field d={d} id="address" set={set} style={{marginTop: 10}}/>
    <Field d={d} id="search" set={set} style={{marginTop: 14}}/>
    <div className="sf-list" role="tree" aria-label="All Notebooks" style={{marginTop: 8, height: 190, overflowY: 'auto'}}>
      {shown.length ? shown.map(l => <div key={l.value} role={l.group ? 'group' : 'treeitem'} aria-selected={!l.group && v.location === l.value}
        className={`sf-list-item${v.location === l.value ? ' is-selected' : ''}`} data-location={l.value}
        style={{paddingLeft: 8 + l.level * 16, fontWeight: l.value.startsWith('page:') ? 400 : 600, opacity: l.group ? 0.7 : 1}}
        onClick={() => { if (!l.group) set('location', l.value); }}>{l.label}</div>)
        : <div className="sf-list-empty">{all.length ? 'Nothing matches' : 'This notebook has no sections yet.'}</div>}
    </div>
    <div style={grid('minmax(0, 1fr)', {marginTop: 12})}><Field d={d} id="createNewPage" set={set}/></div>
  </div>;
}

export default {Body};
