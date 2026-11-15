// Help as a list you can search: the keyboard shortcuts first, then every ribbon command with the tab it is on. The list is the
// application's own spec (shortcuts and commands), so it is always what the application does. Not in gridcraft (not checked
// against upstream); Excel's Help is Microsoft's online help, which this application does not reach.

import {useMemo} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import type {SpecModel, SpecControl} from '../../../generated/spec-types';
import type {DialogState} from '../../../shell/dialogs/dialogState';
import {Fld, type SetValue} from './dataKit';
import './data.css';

/** Shortcut text as the keyboard shows it (the spec once wrote a modifier twice). */
const tidyKeys = (k: string | null | undefined) => String(k ?? '').replace(/\b(Ctrl|Shift|Alt)\+(?=.*\b\1\+)/g, '');

interface Row { id: string; label: string; keys: string; where: string; about: string }

function walk(c: SpecControl, tab: string, group: string, out: Row[], seen: Set<string>, pending: Set<string>) {
  const cc = c as unknown as {id?: string; label?: string; command?: string | null; shortcut?: string | null; items?: SpecControl[]; separator?: boolean};
  if (cc.separator || !cc.label || (cc.id && pending.has(cc.id))) return;
  if (cc.command && !seen.has(cc.command)) { seen.add(cc.command); out.push({id: cc.command, label: cc.label.replace(/…$/, ''), keys: tidyKeys(cc.shortcut), where: `${tab} > ${group}`, about: ''}); }
  for (const k of cc.items ?? []) walk(k, tab, group, out, seen, pending);
}

function rowsOf(spec: SpecModel | null | undefined): Row[] {
  if (!spec) return [];
  const out: Row[] = [], seen = new Set<string>(), pending = new Set(spec.pendingControls);
  for (const t of spec.tabs) for (const g of t.groups) for (const c of g.controls) walk(c as SpecControl, t.label, g.label, out, seen, pending);
  for (const r of out) {
    const cmd = spec.commands[r.id];
    r.about = cmd?.summary ?? '';
    if (!r.keys && cmd?.shortcut) r.keys = tidyKeys(cmd.shortcut);
  }
  return out;
}

function Body({dialog: d, setValue}: {dialog: DialogState; setValue: SetValue}) {
  const {controller} = useEngine();
  const all = useMemo(() => rowsOf((controller as unknown as {model?: {spec?: SpecModel}}).model?.spec), [controller]);
  const q = String(d.values.search ?? '').trim().toLowerCase();
  const rows = useMemo(() => {
    const hit = q ? all.filter(r => `${r.label} ${r.where} ${r.about} ${r.keys}`.toLowerCase().includes(q)) : all;
    return [...hit].sort((a, b) => Number(!!b.keys) - Number(!!a.keys)).slice(0, 80);
  }, [all, q]);
  return <div className="gd-fields">
    <Fld d={d} set={setValue} id="search" kind="text" label="What do you want to do?"/>
    <div className="data-help-list" role="list" aria-label="Help topics" data-field-id="topics">
      {rows.length ? rows.map(r => <div key={r.id} role="listitem" className="data-help-row">
        <span className="data-help-name"><b>{r.label}</b><small>{r.where}</small></span>
        {r.keys ? <kbd>{r.keys}</kbd> : null}
      </div>) : <p className="sf-note">Nothing matches. Try another word.</p>}
    </div>
  </div>;
}

export default {Body};
