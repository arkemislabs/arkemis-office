// A drop-down submenu drawn as a grid of picture tiles under group headings (Conditional Formatting's Data
// Bars, Color Scales and Icon Sets): the entries of a `dynamic` menu item whose spec gives `tiles` (the
// column count); each entry's `art` is the picture, its label the tooltip. Every tile runs the item with
// the entry's value, as a row of a dynamic list does.

import type {TileArtData} from './TileArt';
import {TileArt} from './TileArt';

export interface TileEntry { id?: unknown; label?: unknown; value?: unknown; group?: unknown; art?: TileArtData }

export function TileMenu({controlId, entries, columns, disabled, onPick}: {controlId: string; entries: TileEntry[]; columns: number; disabled: boolean; onPick: (value: unknown) => void}) {
  const groups: [string, TileEntry[]][] = [];
  for (const e of entries) {
    const g = typeof e.group === 'string' ? e.group : '';
    const hit = groups.find(x => x[0] === g);
    if (hit) hit[1].push(e); else groups.push([g, [e]]);
  }
  return <div className="shell-tiles" role="none" data-control-id={controlId}>
    {groups.map(([g, list]) => <section key={g} className="shell-tiles-group">
      {g ? <div className="shell-menu-header" role="presentation">{g}</div> : null}
      <div className="shell-tiles-grid" role="group" aria-label={g || undefined} style={{gridTemplateColumns: `repeat(${columns}, auto)`}}>
        {list.map((e, i) => <button key={String(e.id ?? i)} type="button" role="menuitem" tabIndex={-1} className="rb-tile has-art shell-tile" disabled={disabled}
          title={String(e.label ?? '')} aria-label={String(e.label ?? '')} data-control-id={controlId} data-item={String(e.id ?? i)} onClick={() => onPick(e.value)}>
          {e.art ? <TileArt art={e.art}/> : null}
        </button>)}
      </div>
    </section>)}
  </div>;
}
