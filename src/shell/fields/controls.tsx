// Drawn controls the dialog renderer uses for what a model describes with data instead of a font sample: a
// list with icons, a notebook > group > section tree, a swatch palette, a strength meter, a page thumbnail
// strip, a read-only value box and the New / Current colour pair. Each takes plain data and, when it is
// editable, an `onSelect`. No app code in here: apps pass the data, the shell draws it.

import {useState, type ReactNode} from 'react';
import {Icon, hasIcon} from '../icons/Icon';

export interface ListItem { value: unknown; label: string; detail?: string | null; icon?: string | null; color?: string | null; disabled?: boolean }
export interface TreeItem { value: string; label: string; depth: number; kind?: 'notebook' | 'group' | 'section' | string; color?: string | null; disabled?: boolean }

const asString = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** Strings or {value, label, detail, icon, color} records, as list items. */
export function toItems(raw: unknown): ListItem[] {
  return (Array.isArray(raw) ? raw : []).map((x): ListItem | null => {
    if (typeof x === 'string' || typeof x === 'number') return {value: x, label: String(x)};
    if (!x || typeof x !== 'object') return null;
    const o = x as Record<string, unknown>;
    const label = asString(o.label) || asString(o.name) || asString(o.value);
    return {value: 'value' in o ? o.value : o.id ?? label, label, detail: asString(o.detail) || asString(o.shortcut) || null, icon: asString(o.icon) || null, color: asString(o.color) || null, disabled: o.disabled === true};
  }).filter((x): x is ListItem => !!x);
}

/** Records with a depth (the notebook tree), as tree items. */
export function toTree(raw: unknown): TreeItem[] {
  return (Array.isArray(raw) ? raw : []).map((x): TreeItem | null => {
    if (!x || typeof x !== 'object') return null;
    const o = x as Record<string, unknown>;
    const value = asString(o.value) || asString(o.id);
    if (!value) return null;
    return {value, label: asString(o.label) || asString(o.name) || value, depth: typeof o.depth === 'number' ? o.depth : typeof o.level === 'number' ? o.level : 0,
      kind: asString(o.kind) || 'section', color: asString(o.color) || null, disabled: o.disabled === true};
  }).filter((x): x is TreeItem => !!x);
}

/** An item list with optional icons (the named ribbon icon) and a right-aligned detail (a shortcut). */
export function ItemList({items, selected, onSelect, empty, label, disabled, height}: {items: ListItem[]; selected?: unknown; onSelect?: (value: unknown) => void; empty?: string; label?: string; disabled?: boolean; height?: number}) {
  const same = (a: unknown, b: unknown) => (typeof a === 'string' || typeof a === 'number' ? a === b : JSON.stringify(a) === JSON.stringify(b));
  return <div className={`sf-list${disabled ? ' is-disabled' : ''}`} role="listbox" aria-label={label || undefined} tabIndex={0} style={height ? {height} : undefined}
    onKeyDown={e => {
      if (!onSelect || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault();
      const i = items.findIndex(o => same(o.value, selected));
      const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) onSelect(next.value);
    }}>
    {items.length ? items.map((o, i) => {
      const on = selected !== undefined && same(o.value, selected);
      return <div key={i} role="option" aria-selected={on} className={`sf-list-item${on ? ' is-selected' : ''}${o.disabled ? ' is-disabled' : ''}`} data-value={asString(o.value) || undefined}
        onClick={() => { if (!disabled && !o.disabled) onSelect?.(o.value); }}>
        {o.icon && hasIcon(o.icon) ? <span className="sf-list-icon"><Icon id={o.icon} size={16}/></span> : o.color ? <span className="sf-list-chip" style={{background: o.color}}/> : null}
        <span className="sf-list-label">{o.label}</span>
        {o.detail ? <span className="sf-list-detail">{o.detail}</span> : null}
      </div>;
    }) : <div className="sf-list-empty">{empty ?? 'No items'}</div>}
  </div>;
}

function NodeIcon({kind, color}: {kind?: string; color?: string | null}) {
  const c = color || undefined;
  if (kind === 'notebook') return <svg className="sf-tree-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="3" y="1.5" width="10" height="13" rx="1.6" fill={c ?? '#8b7cd6'}/><rect x="3" y="1.5" width="2.6" height="13" rx="1" fill="rgba(0,0,0,.28)"/><path d="M7.5 5h3.4M7.5 7.5h3.4" stroke="rgba(255,255,255,.85)" strokeWidth="1" strokeLinecap="round"/></svg>;
  if (kind === 'group') return <svg className="sf-tree-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 4.2c0-.7.5-1.2 1.2-1.2h3.1l1.3 1.5h6.2c.7 0 1.2.5 1.2 1.2v6.3c0 .7-.5 1.2-1.2 1.2H2.7c-.7 0-1.2-.5-1.2-1.2z" fill="#c9a24a" opacity=".95"/></svg>;
  return <svg className="sf-tree-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 3.2c0-.7.5-1.2 1.2-1.2h6.4l3.2 3.2v7.6c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2z" fill={c ?? '#6b8fd8'}/><path d="M9.6 2v3.2h3.2" fill="rgba(255,255,255,.35)"/></svg>;
}

/** The notebook tree: the notebook, its section groups and sections indented in tab order; groups fold. */
export function TreeBox({items, selected, onSelect, label, empty, disabled, height}: {items: TreeItem[]; selected?: string | null; onSelect?: (value: string) => void; label?: string; empty?: string; disabled?: boolean; height?: number}) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const hasKids = (i: number) => i + 1 < items.length && items[i + 1].depth > items[i].depth;
  const rows: ReactNode[] = [];
  let hideBelow = Infinity;
  items.forEach((it, i) => {
    if (it.depth > hideBelow) return;
    hideBelow = Infinity;
    const kids = hasKids(i);
    const isFolded = folded.has(it.value);
    if (isFolded) hideBelow = it.depth;
    const on = selected === it.value;
    rows.push(<div key={it.value} role="treeitem" aria-level={it.depth + 1} aria-selected={on} aria-expanded={kids ? !isFolded : undefined} data-value={it.value} data-kind={it.kind}
      className={`sf-tree-row${on ? ' is-selected' : ''}${it.disabled ? ' is-disabled' : ''}`} style={{paddingLeft: 6 + it.depth * 16}}
      onClick={() => { if (!disabled && !it.disabled) onSelect?.(it.value); }}>
      <span className={`sf-tree-twist${kids ? '' : ' is-leaf'}`} onClick={e => { if (!kids) return; e.stopPropagation(); setFolded(s => { const n = new Set(s); if (n.has(it.value)) n.delete(it.value); else n.add(it.value); return n; }); }}>
        {kids ? <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d={isFolded ? 'M3 1.5 7 5 3 8.5' : 'M1.5 3 5 7 8.5 3'} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg> : null}
      </span>
      <NodeIcon kind={it.kind} color={it.color}/>
      <span className="sf-tree-label">{it.label}</span>
    </div>);
  });
  return <div className={`sf-list sf-tree${disabled ? ' is-disabled' : ''}`} role="tree" aria-label={label || undefined} tabIndex={0} style={height ? {height} : undefined}>
    {items.length ? rows : <div className="sf-list-empty">{empty ?? 'Nothing to show'}</div>}
  </div>;
}

/** A drawn palette: honeycomb rows of hexagons (centred, each row its own length) and a strip of greys. */
export function SwatchPalette({rows, greys, selected, onSelect, label, disabled}: {rows: string[][]; greys?: string[]; selected?: string | null; onSelect?: (hex: string) => void; label?: string; disabled?: boolean}) {
  const sel = (selected ?? '').toLowerCase();
  const W = 22, H = 25;
  const widest = Math.max(1, ...rows.map(r => r.length));
  const pad = 6;
  const hex = (cx: number, cy: number, fill: string, key: string, on: boolean) => {
    const pts = [[0, -H / 2], [W / 2, -H / 4], [W / 2, H / 4], [0, H / 2], [-W / 2, H / 4], [-W / 2, -H / 4]].map(([x, y]) => `${(cx + x).toFixed(1)},${(cy + y).toFixed(1)}`).join(' ');
    return <polygon key={key} points={pts} fill={fill} stroke={on ? '#fff' : 'rgba(0,0,0,.35)'} strokeWidth={on ? 2.2 : 0.8} strokeLinejoin="round" role="option" aria-selected={on} aria-label={fill}
      data-color={fill} className="sf-swatch" onClick={() => { if (!disabled) onSelect?.(fill); }}/>;
  };
  const width = widest * W + pad * 2;
  const height = (rows.length - 1) * (H * 0.75) + H + pad * 2;
  const cells: ReactNode[] = [];
  rows.forEach((row, r) => row.forEach((c, i) => {
    const cx = width / 2 + (i - (row.length - 1) / 2) * W;
    cells.push(hex(cx, pad + H / 2 + r * H * 0.75, c, `${r}-${i}`, c.toLowerCase() === sel));
  }));
  return <div className={`sf-swatches${disabled ? ' is-disabled' : ''}`} role="listbox" aria-label={label || 'Colors'}>
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="sf-swatch-hex">{cells}</svg>
    {greys?.length ? <div className="sf-swatch-greys" role="group" aria-label="Greys">
      {greys.map((g, i) => <button key={i} type="button" role="option" aria-selected={g.toLowerCase() === sel} aria-label={g} data-color={g} disabled={disabled}
        className={`sf-swatch-grey${g.toLowerCase() === sel ? ' is-selected' : ''}`} style={{background: g}} onClick={() => onSelect?.(g)}/>)}
    </div> : null}
  </div>;
}

/** The New / Current colour pair (Colors dialog). */
export function ColorPair({next, current}: {next: string; current: string}) {
  return <div className="sf-colorpair" role="img" aria-label={`New ${next}, current ${current}`}>
    <div className="sf-colorpair-new" style={{background: next}}/><div className="sf-colorpair-cur" style={{background: current}}/>
    <span className="sf-colorpair-label is-new">New</span><span className="sf-colorpair-label is-cur">Current</span>
  </div>;
}

/** A strength bar in four steps with its word ("Weak", "Medium", "Strong"). */
export function StrengthMeter({score, label, detail}: {score: number; label: string; detail?: string}) {
  const s = Math.max(0, Math.min(1, score));
  const tone = s >= 0.8 ? 'strong' : s >= 0.45 ? 'medium' : s > 0 ? 'weak' : 'none';
  return <div className={`sf-meter is-${tone}`} role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={s} aria-valuetext={label || 'No password'}>
    <div className="sf-meter-bar"><i style={{width: `${Math.round(s * 100)}%`}}/></div>
    <div className="sf-meter-text"><strong>{label}</strong>{detail ? <span>{detail}</span> : null}</div>
  </div>;
}

/** A strip of page thumbnails: a small page with its number or label under it. */
export function ThumbStrip({pages}: {pages: {label: string; selected?: boolean}[]}) {
  return <div className="sf-thumbs" role="list" aria-label="Pages">
    {pages.length ? pages.map((p, i) => <div key={i} role="listitem" className={`sf-thumb${p.selected ? ' is-selected' : ''}`}>
      <div className="sf-thumb-page"><i/><i/><i/><i/></div><span>{p.label}</span>
    </div>) : <div className="sf-list-empty">No pages</div>}
  </div>;
}

/** A read-only value (a path, a format name): a field that cannot be typed into. */
export function ValueBox({value, label, empty}: {value: string; label?: string; empty?: string}) {
  return <input className="sf-text sf-value" readOnly value={value} placeholder={empty ?? ''} aria-label={label || undefined} title={value || undefined}/>;
}
