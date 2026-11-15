// The spec ribbon (docs/architecture.md section 8.1): File first, then the normal tabs in spec order,
// then the active contextual tabs under their accent color; the active tab's groups fitted to the
// window (section 8.4); the ribbon display options (Always show / Show tabs only / Auto-hide) and the
// collapse chevron. Double-clicking a tab toggles Show tabs only.
//
// Fit: one hidden measurement pass renders every group of the tab at each level once (per tab and
// visible-control signature), a ResizeObserver reports the room there is, batched per animation
// frame, and fit.plan() picks each group's level.

import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useEngine} from '../engine/EngineProvider';
import {useShellState} from '../engine/useCommand';
import {Glyph} from '../icons/Icon';
import {Flyout} from '../common/Flyout';
import {MeasureContext} from './controls';
import {RibbonGroupView, CollapsedGroup} from './RibbonGroup';
import {plan, LEVELS, COLLAPSED, FULL, type Level, type GroupWidths} from './fit';
import type {RibbonGroup} from '../model';
import type {RibbonMode} from '../engine/ShellController';

/** Widths measured per (group key, signature), kept for the window's life. */
const measured = new Map<string, number[]>();

export function SpecRibbon() {
  const {controller} = useEngine();
  const state = useShellState();
  const tabs = controller.visibleTabs();
  const active = controller.activeTab();
  const mode = state.ribbon.mode;
  const showBody = mode === 'always' || state.ribbon.peek;
  const groups = useMemo(() => (active?.groups ?? []).filter(g => controller.groupShows(g)), [active, controller, controller.version, state.flags]);
  const sig = `${controller.version}:${groups.map(g => g.key).join(',')}`;
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => { let alive = true; document.fonts?.ready.then(() => { if (alive) setFontsReady(true); }); return () => { alive = false; }; }, []);
  const key = (g: RibbonGroup) => `${g.key}|${sig}|${fontsReady ? 1 : 0}`;
  const missing = groups.filter(g => !measured.has(key(g)));
  const [, bump] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    let frame = 0;
    // Room for groups: the body's width less its padding (the fold button sits in the right padding).
    const room = () => { const cs = getComputedStyle(el); return Math.floor(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)); };
    const read = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setAvail(room())); };
    setAvail(room());
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, [showBody]);

  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root || !missing.length) return;
    for (const g of missing) {
      const widths = LEVELS.map(level => {
        const el = root.querySelector<HTMLElement>(`[data-measure="${CSS.escape(g.key)}"][data-measure-level="${level}"]`);
        return el ? Math.ceil(el.getBoundingClientRect().width) : NaN;
      });
      measured.set(key(g), widths);
    }
    bump(n => n + 1);
  });

  const levels: Level[] = useMemo(() => {
    if (missing.length || !avail) return groups.map(() => FULL);
    const ws: GroupWidths[] = groups.map(g => ({id: g.key, widths: measured.get(key(g)) ?? [], collapseOrder: g.collapseOrder}));
    return plan(ws, avail);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, avail, missing.length, sig, fontsReady]);

  useEffect(() => { controller.setLevels(Object.fromEntries(groups.map((g, i) => [g.key, levels[i]]))); }, [controller, groups, levels]);

  // Even fully collapsed groups may not fit: the row scrolls, with arrows at the edges (upstream keeps scrolling).
  const [edges, setEdges] = useState({left: false, right: false});
  const readEdges = () => {
    const el = body.current;
    if (!el) return;
    const next = {left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1};
    setEdges(e => (e.left === next.left && e.right === next.right ? e : next));
  };
  useLayoutEffect(readEdges, [levels, avail, active?.id, showBody]);
  const scrollBy = (dir: 1 | -1) => body.current?.scrollBy({left: dir * Math.max(160, (body.current?.clientWidth ?? 400) * 0.6), behavior: 'smooth'});

  // Tabs-only / auto-hide: a click outside the peeking ribbon folds it again.
  useEffect(() => {
    if (mode === 'always' || !state.ribbon.peek) return;
    const down = (e: PointerEvent) => { if (!(e.target as Element).closest?.('.sr, .shell-flyout')) controller.setPeek(false); };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [mode, state.ribbon.peek, controller]);

  if (!controller.model) return null;
  const selectTab = (id: string) => { controller.setTab(id); };
  const tabKeys = (e: React.KeyboardEvent, index: number) => {
    const all = ['#file', ...tabs.map(t => t.id)];
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % all.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + all.length) % all.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = all.length - 1;
    else if (e.key === 'ArrowDown' && index > 0) { e.preventDefault(); body.current?.querySelector<HTMLElement>('button:not(:disabled),input')?.focus(); return; }
    else return;
    e.preventDefault();
    const id = all[next];
    if (id !== '#file') selectTab(id);
    document.querySelector<HTMLElement>(`.sr [data-keytip-id="${CSS.escape(id)}"]`)?.focus();
  };

  return <section className={`sr sr-mode-${mode}${showBody ? '' : ' is-folded'}${state.ribbon.peek && mode !== 'always' ? ' is-peeking' : ''}`} aria-label="Ribbon">
    <div className="sr-tabs" role="tablist" aria-label="Ribbon tabs">
      <button type="button" className={`sr-file${state.backstage.open ? ' is-active' : ''}`} data-keytip-id="#file" aria-haspopup="dialog"
        aria-expanded={state.backstage.open} onClick={() => controller.openBackstage()} onKeyDown={e => tabKeys(e, 0)}>File</button>
      {tabs.map((t, i) => {
        const selected = t.id === active?.id && !state.backstage.open;
        return <button key={t.id} type="button" role="tab" id={`sr-tab-${t.id}`} aria-selected={selected} aria-controls="sr-panel"
          tabIndex={selected ? 0 : -1} className={`sr-tab${t.contextual ? ' is-contextual' : ''}${selected ? ' is-active' : ''}`}
          data-keytip-id={t.id} data-tab-id={t.id} onClick={() => selectTab(t.id)} onDoubleClick={() => controller.toggleRibbonCollapsed()}
          onKeyDown={e => tabKeys(e, i + 1)}>{t.label}</button>;
      })}
      <span className="sr-tabs-fill"/>
      <DisplayOptions mode={mode}/>
    </div>
    {showBody ? <div className="sr-panel" id="sr-panel" role="tabpanel" aria-labelledby={active ? `sr-tab-${active.id}` : undefined}>
      {edges.left ? <button type="button" className="sr-scroll is-left" aria-label="Scroll the ribbon left" tabIndex={-1} onClick={() => scrollBy(-1)}><Glyph name="chevron-left" size={12}/></button> : null}
      {edges.right ? <button type="button" className="sr-scroll is-right" aria-label="Scroll the ribbon right" tabIndex={-1} onClick={() => scrollBy(1)}><Glyph name="chevron-right" size={12}/></button> : null}
      <div className="sr-body" ref={body} onScroll={readEdges}>
        <div className="sr-groups" data-tab={active?.id}>
          {groups.map((g, i) => <div key={g.key} className="rg-slot">
            {levels[i] === COLLAPSED ? <CollapsedGroup group={g}/> : <RibbonGroupView group={g} level={levels[i]}/>}
            <span className="rg-divider" aria-hidden="true"/>
          </div>)}
        </div>
        {missing.length ? <div ref={measureRef} className="sr-measure" aria-hidden="true">
          <MeasureContext.Provider value={true}>
            {missing.map(g => LEVELS.map(level => <div key={`${g.key}-${level}`} className="rg-slot" data-measure={g.key} data-measure-level={level}>
              {level === COLLAPSED ? <CollapsedGroup group={g}/> : <RibbonGroupView group={g} level={level}/>}
              <span className="rg-divider"/>
            </div>))}
          </MeasureContext.Provider>
        </div> : null}
      </div>
      {mode === 'always' ? <button type="button" className="sr-fold" aria-label="Collapse the ribbon" data-tip="Collapse the Ribbon" data-tip-keys="Ctrl+F1"
        onClick={() => controller.setRibbonMode('tabs')}><Glyph name="chevron-up" size={12}/></button>
        : <button type="button" className="sr-fold" aria-label="Pin the ribbon" data-tip="Pin the Ribbon" onClick={() => controller.setRibbonMode('always')}><Glyph name="pin" size={12}/></button>}
    </div> : null}
  </section>;
}

function DisplayOptions({mode}: {mode: RibbonMode}) {
  const {controller} = useEngine();
  const state = useShellState();
  const anchor = useRef<HTMLButtonElement>(null);
  const open = state.menu === '#ribbon-display';
  const pick = (m: RibbonMode) => { controller.setMenu(null); controller.setRibbonMode(m); };
  const options: [RibbonMode, string, string][] = [
    ['always', 'Always show Ribbon', 'Keep the ribbon open all the time'],
    ['tabs', 'Show tabs only', 'Show only the tab names; click a tab to open the ribbon'],
    ['autohide', 'Full-screen mode', 'Hide the ribbon until you click a tab'],
  ];
  return <>
    <button ref={anchor} type="button" className="sr-display" aria-label="Ribbon display options" aria-haspopup="menu" aria-expanded={open}
      data-tip="Ribbon Display Options" onClick={() => controller.setMenu(open ? null : '#ribbon-display')}><Glyph name="ribbon" size={13}/><Glyph name="chevron-down" size={9}/></button>
    <Flyout anchor={anchor} open={open} onClose={() => controller.setMenu(null)} placement="below-end" label="Ribbon display options">
      <div className="shell-menu">
        <div className="shell-menu-header">Ribbon display</div>
        {options.map(([m, label, help]) => <div key={m} role="menuitemcheckbox" aria-checked={mode === m} tabIndex={-1} className="shell-menu-item is-tall"
          onClick={() => pick(m)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(m); } }}>
          <span className="shell-menu-check">{mode === m ? <Glyph name="check" size={12}/> : null}</span>
          <span className="shell-menu-label">{label}<small>{help}</small></span>
        </div>)}
      </div>
    </Flyout>
  </>;
}
