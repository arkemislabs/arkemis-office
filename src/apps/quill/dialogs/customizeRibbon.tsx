// Customize Ribbon and Quick Access Toolbar (File › Options › Customize Ribbon, QAT menu › More Commands…): Word's two-list arrangement. On the
// left every command the ribbon has (choose from All Commands or one tab), Add >> and << Remove in the middle, on the right the real tab tree with
// a Show check box for each tab, its groups (the built-in ones from the ribbon, the custom ones from the layout) and the commands in a custom
// group; New Tab, New Group, Rename and Reset underneath. The Quick Access Toolbar page is the same with its own list.
// Over core/common/dialogs/customizeRibbon.mjs (the buttons are its `buttons`; the Show boxes change the layout Close applies).
// Layout from wordcraft crates/ui-egui/src/dialogs/dialogs_ribbon.rs at aadb077e072b7de05f724e359d8db82e151f125c. MIT, see
// assets/third-party-licenses/artcraft-reference.txt.

import {useMemo, useState} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {displayLabel, isControl} from '../../../shell/model';
import {PageTabs, type BodyProps} from './font';

type Tab = {name: string; custom?: boolean; hidden?: boolean; groups?: {name: string; commands: string[]}[]};
type Row = {key: string; kind: 'tab' | 'group' | 'command'; depth: number; label: string; tab: string; group?: string; command?: string; hidden?: boolean; custom?: boolean};

const list: React.CSSProperties = {border: '1px solid var(--gd-border, #3a3b42)', borderRadius: 6, background: 'rgba(0,0,0,.18)', height: 250, overflow: 'auto', padding: 2};
const row = (on: boolean, depth = 0): React.CSSProperties => ({display: 'flex', alignItems: 'center', gap: 6, padding: '2px 6px', paddingLeft: 6 + depth * 16, borderRadius: 4, cursor: 'default', fontSize: 12.5, background: on ? 'rgba(120,160,255,.22)' : undefined});

function Body({dialog: d, setValue: set}: BodyProps) {
  const {controller} = useEngine();
  const model = controller.model;
  const qat = d.tab === 1;
  const v = d.values as {tabs?: Tab[]; qat?: string[]; search?: string; command?: string | null; tab?: string | null; group?: string | null; qatCommand?: string | null; name?: string};
  const [from, setFrom] = useState('all');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const press = (id: string) => { void controller.pressField(d.key, id).catch(e => controller.notify(toCommandError(e).message, 'error')); };

  // Every command the ribbon has, once, with the label the ribbon shows.
  const commands = useMemo(() => {
    const out: {id: string; label: string; tab: string}[] = [];
    const seen = new Set<string>();
    for (const t of model?.tabs ?? []) for (const g of t.groups) {
      const walk = (c: unknown) => {
        if (!isControl(c as never)) return;
        const k = c as {command?: string | null; label: string; items?: unknown[]};
        if (k.command && !seen.has(k.command)) { seen.add(k.command); out.push({id: k.command, label: displayLabel(k as never), tab: t.label}); }
        for (const x of k.items ?? []) walk(x);
      };
      for (const c of g.controls) walk(c);
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [model]);
  const labelOf = (id: string) => commands.find(c => c.id === id)?.label ?? id;
  const tabNames = useMemo(() => [...new Set(commands.map(c => c.tab))], [commands]);
  const q = String(v.search ?? '').trim().toLowerCase();
  const shown = commands.filter(c => (from === 'all' || c.tab === from) && (!q || c.label.toLowerCase().includes(q)));

  // The tab tree: each tab (Show check box), its groups and the commands of a custom group.
  const tabs = v.tabs ?? [];
  const rows: Row[] = [];
  for (const t of tabs) {
    rows.push({key: `t:${t.name}`, kind: 'tab', depth: 0, label: t.name, tab: t.name, hidden: !!t.hidden, custom: !!t.custom});
    if (!open[t.name]) continue;
    const spec = (model?.tabs ?? []).find(x => x.label === t.name);
    const custom = t.groups ?? [];
    for (const g of spec && !t.custom ? spec.groups : []) rows.push({key: `g:${t.name}:${g.label}`, kind: 'group', depth: 1, label: g.label, tab: t.name});
    for (const g of custom) {
      rows.push({key: `cg:${t.name}:${g.name}`, kind: 'group', depth: 1, label: `${g.name} (Custom)`, tab: t.name, group: g.name, custom: true});
      for (const c of g.commands) rows.push({key: `c:${t.name}:${g.name}:${c}`, kind: 'command', depth: 2, label: labelOf(c), tab: t.name, group: g.name, command: c});
    }
  }
  const setHidden = (name: string, hidden: boolean) => set('tabs', tabs.map(t => (t.name === name ? (hidden ? {...t, hidden: true} : (({hidden: _h, ...rest}) => rest)(t)) : t)));
  const pick = (r: Row) => { set('tab', r.tab); set('group', r.group ?? null); set('command', null); };

  const left = <div style={{display: 'grid', gap: 6, minWidth: 0}}>
    {!qat ? <label className="sf" style={{display: 'grid', gap: 3}}><span className="sf-label">Choose commands from:</span>
      <select className="sf-select" aria-label="Choose commands from" value={from} onChange={e => setFrom(e.target.value)}>
        <option value="all">All Commands</option>{tabNames.map(n => <option key={n} value={n}>{n}</option>)}
      </select></label> : <span className="sf-label">Choose commands from: All Commands</span>}
    <input className="sf-text" aria-label="Search" placeholder="Search commands" value={String(v.search ?? '')} onChange={e => set('search', e.target.value)}/>
    <div role="listbox" aria-label="Commands" style={list}>
      {shown.map(c => <div key={c.id} role="option" aria-selected={v.command === c.id} style={row(v.command === c.id)} onClick={() => set('command', c.id)}>{c.label}</div>)}
      {!shown.length ? <small style={{opacity: 0.6, padding: 6, display: 'block'}}>No command matches.</small> : null}
    </div>
  </div>;

  const mid = <div style={{display: 'grid', gap: 8, alignContent: 'center'}}>
    <button type="button" className="sf-button" onClick={() => press('add')}>Add &gt;&gt;</button>
    <button type="button" className="sf-button" onClick={() => press('remove')}>&lt;&lt; Remove</button>
  </div>;

  const right = qat ? <div style={{display: 'grid', gap: 6, minWidth: 0}}>
    <span className="sf-label">Customize Quick Access Toolbar:</span>
    <div role="listbox" aria-label="Quick Access Toolbar" style={list}>
      {(v.qat ?? []).map(c => <div key={c} role="option" aria-selected={v.qatCommand === c} style={row(v.qatCommand === c)} onClick={() => set('qatCommand', c)}>{labelOf(c)}</div>)}
    </div>
  </div> : <div style={{display: 'grid', gap: 6, minWidth: 0}}>
    <span className="sf-label">Customize the Ribbon: Main Tabs</span>
    <div role="tree" aria-label="Ribbon tabs" style={list}>
      {rows.map(r => <div key={r.key} role="treeitem" aria-selected={r.kind === 'command' ? v.command === r.command && v.group === r.group : v.tab === r.tab && (v.group ?? null) === (r.group ?? null) && r.kind === (v.group ? 'group' : 'tab')}
        style={row(v.tab === r.tab && ((r.kind === 'tab' && !v.group) || (r.kind !== 'tab' && (v.group ?? null) === (r.group ?? null) && r.kind === 'group')), r.depth)} onClick={() => pick(r)}>
        {r.kind === 'tab' ? <>
          <button type="button" aria-label={open[r.tab] ? 'Collapse' : 'Expand'} className="sf-button" style={{width: 18, height: 18, padding: 0, lineHeight: 1}} onClick={e => { e.stopPropagation(); setOpen({...open, [r.tab]: !open[r.tab]}); }}>{open[r.tab] ? '−' : '+'}</button>
          <input type="checkbox" aria-label={`Show ${r.label}`} checked={!r.hidden} onChange={e => setHidden(r.tab, !e.target.checked)} onClick={e => e.stopPropagation()}/>
        </> : null}
        <span>{r.label}</span>
      </div>)}
    </div>
  </div>;

  return <div className="gd-fields" data-dialog-page={d.spec.tabs[d.tab]?.name}>
    <PageTabs dialog={d}/>
    <div style={{display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr) auto', gap: 10, alignItems: 'start', marginTop: 8}}>
      {left}{mid}{right}
      <div style={{display: 'grid', gap: 8, alignContent: 'center'}}>
        <button type="button" className="sf-button" aria-label="Move Up" title="Move Up" onClick={() => press('up')}>{'▲'}</button>
        <button type="button" className="sf-button" aria-label="Move Down" title="Move Down" onClick={() => press('down')}>{'▼'}</button>
      </div>
    </div>
    {!qat ? <div style={{display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap'}}>
      <button type="button" className="sf-button" onClick={() => press('newTab')}>New Tab</button>
      <button type="button" className="sf-button" onClick={() => press('newGroup')}>New Group</button>
      <input className="sf-text" aria-label="Name" placeholder="Name" style={{width: 160}} value={String(v.name ?? '')} onChange={e => set('name', e.target.value)}/>
      <button type="button" className="sf-button" onClick={() => press('rename')}>Rename</button>
      <span style={{flex: 1}}/>
      <button type="button" className="sf-button" onClick={() => press('reset')}>Reset</button>
    </div> : <div style={{display: 'flex', gap: 8, marginTop: 10}}><span style={{flex: 1}}/><button type="button" className="sf-button" onClick={() => press('reset')}>Reset</button></div>}
  </div>;
}

export default {Body};
