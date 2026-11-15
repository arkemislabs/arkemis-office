// The title bar (docs/architecture.md section 13): the Arkemis traffic lights at the top left (close,
// minimize, maximize circles with glyphs on hover, dimmed when unfocused, no-drag hit areas), the
// app mark, AutoSave, the Quick Access Toolbar, the document title (rename in place, then the save
// state), and the Tell-me search, which searches the registry's commands and the ribbon's controls
// and runs the chosen one. Everything interactive is -webkit-app-region: no-drag; the rest drags.
// The title is the document's file name as Office shows it (Document1 until the first save, then the
// file's name), with whether its file has every change; FileLifecycle ties the window to the file.

import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {toCommandError} from '../../../core/kernel/errors.mjs';
import type {SpecControl} from '../../generated/spec-types';
import {WindowControls} from '../../WindowControls';
import {useEngine} from '../engine/EngineProvider';
import {useSessionTick, useShellState} from '../engine/useCommand';
import {RibbonControl, MeasureContext, shortcutText} from '../ribbon/controls';
import {Flyout} from '../common/Flyout';
import {Glyph, Icon, hasIcon} from '../icons/Icon';
import {displayLabel, isControl} from '../model';
import {qatKeytips} from '../keys/keytipTable';
import {FileLifecycle, useFileBinding} from './FileLifecycle';

const PRODUCT: Record<string, string> = {quill: 'Quill', grid: 'Grid', prism: 'Prism', folio: 'PDF', slate: 'Slate'};

/** ":2" when this window is the second of several on the document (the main process's window list), else "". */
function useWindowNumber(docId: string): string {
  const wins = (window as any).studio?.windows;
  const read = () => {
    const list: {doc: string | null; self: boolean}[] = wins?.state?.()?.windows ?? [];
    const same = list.filter(w => w.doc === docId);
    const i = same.findIndex(w => w.self);
    return same.length > 1 && i >= 0 ? `:${i + 1}` : '';
  };
  const [n, setN] = useState(read);
  useEffect(() => (wins?.onState ? wins.onState(() => setN(read())) : undefined), [docId]);
  return n;
}

export function TitleBar({saving, onBack}: {saving?: boolean; onBack?: () => void}) {
  const {controller, session, docId, kind} = useEngine();
  useSessionTick();
  const state = useShellState();
  const binding = useFileBinding();
  const doc = (() => { try { return session.get(docId); } catch { return null; } })();
  // The AutoSave switch is drawn by the title bar itself, so the QAT does not repeat it.
  const qat = controller.qat().filter(c => c.command !== 'file.autosave' && !/^auto ?save$/i.test(String(c.label)));
  const autosave = controller.hasCommand('file.autosave');
  const autosaveOn = autosave && !!session.state(docId, 'file.autosave').checked;
  const dirty = !!doc?.dirty;
  // With a real file (Office): AutoSave on shows Saved / Saving…; otherwise whether the file has every change.
  const status = binding
    ? autosaveOn ? (dirty ? 'Saving…' : 'Saved') : binding.path ? (dirty ? 'Not saved' : 'Saved to this PC') : (dirty ? 'Not saved' : '')
    : saving ? 'Saving…' : dirty && !autosaveOn ? 'Not saved' : 'Saved';
  // View › New Window (Word): a document shown in two windows is "Report:1" and "Report:2".
  const windowNo = useWindowNumber(docId);
  const name = binding?.name ?? doc?.file.title ?? '';
  const where = binding ? binding.path ?? 'Not saved yet' : undefined;
  void onBack;
  return <header className="shell-titlebar" data-focused="true">
    <div className="shell-titlebar-start">
      <WindowControls/>
      <img className="tb-mark" src={`./brand/products/${kind}.svg`} alt="" draggable={false}/>
      {autosave ? <AutoSave on={autosaveOn} reason={autosave ? session.state(docId, 'file.autosave').reason : undefined}/> : null}
      {qat.length ? <Qat controls={qat}/> : null}
      <DocumentTitle title={name} suffix={windowNo} status={status} dirty={dirty} where={where}/>
    </div>
    <div className="shell-titlebar-center"><TellMe focus={state.menu === 'search'}/></div>
    <div className="shell-titlebar-end"><span className="tb-product">{PRODUCT[kind] ?? kind}</span></div>
    <FileLifecycle/>
  </header>;
}

function AutoSave({on, reason}: {on: boolean; reason?: string}) {
  const {controller} = useEngine();
  return <button type="button" className={`tb-autosave${on ? ' is-on' : ''}`} role="switch" aria-checked={on} aria-label="AutoSave" data-tip="AutoSave"
    data-tip-desc={on ? 'Your changes are saved to the file as you work' : reason ?? 'Save changes to the file as you work'} onClick={() => { void controller.run('file.autosave', {value: !on}); }}>
    <span>AutoSave</span><i aria-hidden="true"><b/></i><small>{on ? 'On' : 'Off'}</small>
  </button>;
}

/**
 * The Quick Access Toolbar: as many commands as fit beside the document title (which keeps at
 * least 110 px); the rest move into the QAT menu. Widths come from a hidden measuring row.
 */
function Qat({controls}: {controls: SpecControl[]}) {
  const root = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(controls.length);
  useLayoutEffect(() => {
    const start = root.current?.parentElement;
    const m = measure.current;
    if (!start || !m) return;
    const check = () => {
      const widths = (Array.from(m.children) as HTMLElement[]).map(c => c.offsetWidth);
      let other = 0;
      for (const ch of Array.from(start.children) as HTMLElement[]) if (ch !== root.current && !ch.classList.contains('tb-title')) other += ch.offsetWidth + 4;
      // The document name keeps room for about 20 characters before the QAT takes it.
      const avail = start.clientWidth - other - 200 - 30;
      let n = 0, sum = 0;
      for (const w of widths) { if (sum + w + 1 > avail) break; sum += w + 1; n++; }
      setCount(c => (c === n ? c : n));
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(start);
    return () => ro.disconnect();
  }, [controls]);
  const tips = qatKeytips(controls.length);
  const shown = controls.slice(0, count), overflow = controls.slice(count);
  return <div ref={root} className="tb-qat" role="toolbar" aria-label="Quick Access Toolbar">
    <div className="tb-qat-items">
      {shown.map((c, i) => <span key={c.id} className="tb-qat-item" data-keytip-id={`#qat:${c.id}`} data-keytip-text={tips[i]}><RibbonControl c={c} size="small"/></span>)}
    </div>
    <div ref={measure} className="tb-qat-measure" aria-hidden="true">
      <MeasureContext.Provider value={true}>{controls.map(c => <span key={c.id} className="tb-qat-item"><RibbonControl c={c} size="small"/></span>)}</MeasureContext.Provider>
    </div>
    <QatMenu overflow={overflow}/>
  </div>;
}

/** Customize Quick Access Toolbar: commands that did not fit, then the defaults and the available commands, checked when shown. */
function QatMenu({overflow}: {overflow: SpecControl[]}) {
  const {controller} = useEngine();
  const state = useShellState();
  const anchor = useRef<HTMLButtonElement>(null);
  const open = state.menu === '#qat-menu';
  const current = new Set(controller.qat().map(c => c.command));
  const candidates = [...new Set([...(controller.model?.spec.qat ?? []).filter(isControl).map(c => c.command), ...(controller.model?.spec.qatAvailable ?? []),
    'file.save', 'edit.undo', 'edit.redo', 'edit.repeat'])].filter((c): c is string => !!c && controller.hasCommand(c));
  const toggle = (cmd: string) => {
    void controller.run('tools.customizeRibbon', current.has(cmd) ? {qatRemove: cmd} : {qatAdd: cmd}, {origin: 'ui'});
  };
  return <>
    <button ref={anchor} type="button" className="tb-icon tb-qat-more" aria-label="Customize Quick Access Toolbar" aria-haspopup="menu" aria-expanded={open}
      data-tip="Customize Quick Access Toolbar" onClick={() => controller.setMenu(open ? null : '#qat-menu')}><Glyph name="chevron-down" size={10}/></button>
    <Flyout anchor={anchor} open={open} onClose={() => controller.setMenu(null)} label="Customize Quick Access Toolbar">
      <div className="shell-menu">
        {overflow.length ? <>
          {overflow.map(c => <div key={c.id} role="menuitem" tabIndex={-1} className="shell-menu-item"
            onClick={() => { controller.setMenu(null); void controller.activate(c.id).catch(e => controller.notify(toCommandError(e).message, 'error')); }}>
            <span className="shell-menu-check">{hasIcon(c.icon) ? <Icon id={c.icon} size={16}/> : null}</span>
            <span className="shell-menu-label">{displayLabel(c)}</span><span className="shell-menu-keys">{shortcutText(c.shortcut)}</span></div>)}
          <div className="shell-menu-sep" role="separator"/>
        </> : null}
        <div className="shell-menu-header">Customize Quick Access Toolbar</div>
        {candidates.map(cmd => <div key={cmd} role="menuitemcheckbox" aria-checked={current.has(cmd)} tabIndex={-1} className="shell-menu-item"
          onClick={() => toggle(cmd)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(cmd); } }}>
          <span className="shell-menu-check">{current.has(cmd) ? <Glyph name="check" size={12}/> : null}</span>
          <span className="shell-menu-label">{controller.command(cmd)?.label ?? cmd}</span>
        </div>)}
        {controller.dialogImplemented('dialog.customizeRibbon') ? <>
          <div className="shell-menu-sep" role="separator"/>
          <div role="menuitem" tabIndex={-1} className="shell-menu-item" onClick={() => { controller.setMenu(null); void controller.run('tools.customizeRibbon', null); }}>
            <span className="shell-menu-check"/><span className="shell-menu-label">More Commands…</span></div>
        </> : null}
      </div>
    </Flyout>
  </>;
}

/** The document name: click to rename in place (file.rename: a saved file is renamed in its folder), with the save state after it. */
function DocumentTitle({title, suffix = '', status, dirty = false, where}: {title: string; suffix?: string; status: string; dirty?: boolean; where?: string}) {
  const {controller} = useEngine();
  const [edit, setEdit] = useState<string | null>(null);
  const canRename = controller.hasCommand('file.rename');
  const commit = () => {
    const name = (edit ?? '').trim();
    setEdit(null);
    if (name && name !== title) void controller.run('file.rename', {name}, {origin: 'ui'}).catch(e => controller.notify(toCommandError(e).message, 'error'));
  };
  if (edit !== null) return <input className="tb-title-input" aria-label="Document name" autoFocus value={edit} maxLength={240}
    onChange={e => setEdit(e.target.value)} onBlur={commit} onFocus={e => e.target.select()}
    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.preventDefault(); setEdit(null); } }}/>;
  return <button type="button" className={`tb-title${dirty ? ' is-dirty' : ''}`} aria-label={`Document name: ${title}.${status ? ' ' + status : ''}`} disabled={!canRename}
    data-tip={canRename ? title : undefined} data-tip-desc={where} onClick={() => canRename && setEdit(title)}>
    <span className="tb-title-name">{title}{suffix}</span>
    {status ? <><span className="tb-title-sep" aria-hidden="true">•</span><span className="tb-title-status">{status}</span></> : null}
  </button>;
}

interface Hit { id: string; label: string; detail: string; icon: string | null; run: () => void }

/** Tell me (Alt+Q): commands and ribbon controls by label, run with Enter. */
function TellMe({focus}: {focus: boolean}) {
  const {controller} = useEngine();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) { input.current?.focus(); controller.setMenu(null); } }, [focus, controller]);
  const hits = useMemo<Hit[]>(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const out: Hit[] = [];
    const seen = new Set<string>();
    const tabOf = (c: SpecControl) => { const p = controller.model?.place.get(c.id) ?? controller.model?.place.get(controller.model?.parent.get(c.id) ?? ''); return p ? controller.model?.tabs.find(t => t.id === p.tab)?.label ?? '' : ''; };
    for (const c of controller.model?.controls.values() ?? []) {
      if (out.length >= 8) break;
      if (!c.command || seen.has(c.command + JSON.stringify(c.args)) || !controller.isImplemented(c)) continue;
      if (!displayLabel(c).toLowerCase().includes(query)) continue;
      seen.add(c.command + JSON.stringify(c.args));
      out.push({id: c.id, label: displayLabel(c), detail: tabOf(c), icon: c.icon, run: () => { void controller.activate(c.id).catch(e => controller.notify(toCommandError(e).message, 'error')); }});
    }
    for (const cmd of controller.session.registry.list({search: query})) {
      if (out.length >= 10) break;
      if ([...seen].some(s => s.startsWith(cmd.id + '{') || s.startsWith(cmd.id + 'null'))) continue;
      seen.add(cmd.id + 'null');
      out.push({id: cmd.id, label: cmd.label, detail: shortcutText(Array.isArray(cmd.shortcut) ? cmd.shortcut[0] : cmd.shortcut) ?? cmd.family, icon: null,
        run: () => { void controller.run(cmd.id, null); }});
    }
    return out;
  }, [q, controller]);
  const go = (h?: Hit) => { if (!h) return; setOpen(false); setQ(''); h.run(); };
  return <div ref={box} className={`tb-search${open && hits.length ? ' is-open' : ''}`}>
    <Glyph name="search" size={13}/>
    <input ref={input} aria-label="Search commands" placeholder="Search" value={q} role="combobox" aria-expanded={open && hits.length > 0} aria-controls="tb-search-results"
      onChange={e => { setQ(e.target.value); setOpen(true); setIndex(0); }} onFocus={() => setOpen(true)}
      onKeyDown={e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(hits.length - 1, i + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); go(hits[index]); }
        else if (e.key === 'Escape') { e.preventDefault(); setQ(''); setOpen(false); controller.focusSurface(); }
      }}/>
    <kbd>Alt+Q</kbd>
    <Flyout anchor={box} open={open && hits.length > 0} onClose={() => setOpen(false)} role="listbox" label="Search results" initialFocus={false} matchWidth className="is-search">
      <div id="tb-search-results" className="shell-menu">
        <div className="shell-menu-header">Actions</div>
        {hits.map((h, i) => <div key={h.id} role="option" aria-selected={i === index} className={`shell-menu-item${i === index ? ' is-active' : ''}`}
          onMouseEnter={() => setIndex(i)} onMouseDown={e => e.preventDefault()} onClick={() => go(h)}>
          <span className="shell-menu-check">{hasIcon(h.icon) ? <Icon id={h.icon} size={16}/> : <Glyph name="search" size={11}/>}</span>
          <span className="shell-menu-label">{h.label}</span><span className="shell-menu-keys">{h.detail}</span>
        </div>)}
      </div>
    </Flyout>
  </div>;
}
