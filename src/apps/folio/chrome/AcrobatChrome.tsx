// The PDF window's chrome (manifest.chrome): Acrobat's layout in place of an Office ribbon.
//
//   ┌ title bar (the shell's) ─────────────────────────────────────────────────────────────────┐
//   │ ☰ │ All tools  Edit  Convert  E-Sign                          ⓘ  💾  (mode bar)            │
//   ├──────────────┬────────────────────────────────────────────────┬──────────────┬───────────┤
//   │ tool panel:  │ ┌──┐  contextual bars (Organize toolbar, Find…) │ right panel  │ rail:     │
//   │ All tools ▸  │ │↖ │                                            │ (Comments,   │ panels    │
//   │ tool detail, │ │✋ │      the page view (FolioSurface)          │ Signatures,  │ …         │
//   │ Edit/Convert │ │💬│                                            │ thumbnails)  │ page box  │
//   │ /E-Sign, or  │ └──┘ quick bar (floating)                       │              │ zoom      │
//   │ Organize…    │                                                │              │           │
//   └──────────────┴────────────────────────────────────────────────┴──────────────┴───────────┘
//
// Translated for placement from printcraft crates/ui-egui/src/chrome.rs (mode_bar: menus, the four
// mode tabs, then right to left Print, Save, Document properties and Find tools; right_rail: the
// panel toggles on top, the page and zoom cluster at the foot), panels/tools.rs (left_panel: All
// tools rows, a tool's detail panel with Back and Close; Organize pages takes the panel while the
// grid shows), canvas/bars.rs quick_bar (floating at the document's top-left, 14 px in) and
// canvas/organize.rs organize_toolbar (the bar over the page grid) at
// 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see assets/third-party-licenses/artcraft-reference.txt).
//
// Everything is driven by the spec (docs/spec/pdf.json): the mode tabs are the `modeTab` tabs, the
// tool rows the All tools groups, the quick bar, rail and mode-bar controls the `floatingToolbar`,
// `rail` and `chrome` groups, the left contextual panels and bars the contextual tabs. Every spec
// control renders through the ribbon's control components (RibbonControl), so activation, state,
// check marks, menus and the bridge are the ribbon's, and untranslated controls stay hidden in
// production (controller.shows). The groups drawn are reported with controller.setLevels so
// ui.inspect lists them; ui.tab 'edit' switches mode, ui.tab 'all-tools/comment' opens a tool.

import {Suspense, lazy, useEffect, useMemo, useRef, useState, type ComponentType, type LazyExoticComponent, type ReactNode} from 'react';
import type {ChromeProps} from '../../../shell/AppHost';
import type {SpecControl} from '../../../generated/spec-types';
import type {RibbonGroup, RibbonTab} from '../../../shell/model';
import {isControl, displayLabel} from '../../../shell/model';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick, useShellState} from '../../../shell/engine/useCommand';
import {RibbonControl, FlyoutPlacement} from '../../../shell/ribbon/controls';
import {FULL, COLLAPSED, type Level} from '../../../shell/ribbon/fit';
import {Icon} from '../../../shell/icons/Icon';
import {preloadPane, type PaneProps} from '../../../shell/panes/PaneHost';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import {pageLabel} from '../../../../core/folio/model/index.mjs';
import {viewOf} from '../surface/metrics';
import {selectedIndices} from '../surface/OrganizeGrid';
import AllToolsPage from './AllToolsPage';
import NoticeBar from './NoticeBar';
import './acrobat.css';

type Ctl = ReturnType<typeof useEngine>['controller'];

/** The spec groups this chrome draws outside the tab strip (title bar's mode bar, the quick bar, the rail). */
const MODE_BAR = 'title-bar/mode-bar';
const QUICK = ['quick-tools/quick-bar', 'quick-tools/fill-and-sign-text-size', 'quick-tools/comment-tool-properties'];
const RAIL_PANELS = 'right-rail/panels';
const RAIL_NAV = 'right-rail/page-navigation-and-zoom';
/** Mode-bar controls the tab buttons stand for (the mode tabs themselves), not drawn again. */
const MODE_TOGGLES = new Set(['chrome.mode.menus', 'chrome.mode.all-tools', 'chrome.mode.edit', 'chrome.mode.convert', 'chrome.mode.esign']);
/** Header groups of a tool panel: their buttons sit in the panel's title row. */
const HEADER_GROUPS = new Set(['all-tools-panel', 'panel-header']);
/** Groups whose leading buttons Acrobat draws as a row of icons (Organize ▸ Page options, Fill & Sign, Edit ▸ Image). */
const ICON_ROWS: Record<string, number> = {'organize-pages/page-options': 4, 'e-sign/fill': 6, 'all-tools/fill_sign': 6};
/** Groups drawn as the bar over the page view rather than in the panel (printcraft organize_toolbar). */
/** The Enhance camera image bar's buttons that carry their names (the others are icons with tooltips). */
const LABELLED = /^camera\.(crop|organize|enhance|done|cancel)$/;
const isToolbarGroup = (g: RibbonGroup) => /toolbar$/.test(g.id);
/** A bar's Save and Close sit at its right end, Close last (printcraft organize_toolbar lays them out right to left). */
const isBarEnd = (c: SpecControl) => /(close|save-pages)$/.test(c.id);
/** printcraft panels/tools.rs COLLAPSED_TOOLS: the All tools list shows this many until View more. */
const COLLAPSED_TOOLS = 14;
/** The rail's own panels (view.rightPanel) and the shell pane each opens. */
const RIGHT_PANES: Record<string, {pane: string; command: string}> = {comments: {pane: 'comments', command: 'comment.list'}, signatures: {pane: 'signatures', command: 'sign.panel'}, fields: {pane: 'fields', command: 'form.fields'}, search: {pane: 'search', command: 'edit.advanced_search'}, layers: {pane: 'layers', command: 'layers.panel'}, attachments: {pane: 'attachments', command: 'attachments.panel'}, tags: {pane: 'tags', command: 'a11y.tags'}, accessibility: {pane: 'accessibility', command: 'a11y.panel'}, standards: {pane: 'standards', command: 'standards.panel'}};

const groupByKey = (controller: Ctl, key: string): RibbonGroup | null => {
  for (const t of controller.model?.tabs ?? []) for (const g of t.groups) if (g.key === key) return g;
  return null;
};
const controlsOf = (g: RibbonGroup | null) => (g?.controls ?? []).filter(isControl);
const report = (controller: Ctl, msg: unknown) => controller.notify(toCommandError(msg).message, 'error');

export default function AcrobatChrome({controller, surface, inlineBars, leftPanes, rightPanes}: ChromeProps) {
  const state = useShellState();
  useSessionTick();
  const {session, docId} = useEngine();
  const doc: any = (() => { try { return session.get(docId); } catch { return null; } })();
  const view: any = doc?.view ?? {};
  const tabs = controller.visibleTabs();
  const active = controller.activeTab();
  const modes = tabs.filter(t => !t.contextual && t.surface === 'modeTab');
  // The mode the person is in: the active tab, or the one a contextual panel opened from.
  const mode: RibbonTab | null = active && !active.contextual ? active
    : modes.find(t => t.id === state.previousTab) ?? modes[0] ?? null;
  const contextual = active?.contextual && active.surface === 'contextualPanel' ? active : null;
  const bars = tabs.filter(t => t.contextual && t.surface !== 'contextualPanel');
  const panel = state.panel && mode && state.panel.startsWith(`${mode.id}/`) ? groupByKey(controller, state.panel) : null;
  const [leftOpen, setLeftOpen] = useState(true);
  // View > Show or hide the Tools panel (view.tools_pane) is view state the panel follows.
  useEffect(() => { if (view.toolsPane !== undefined) setLeftOpen(view.toolsPane !== false); }, [view.toolsPane]);

  // What is drawn, reported as fit levels (ui.inspect lists these groups' controls; collapsed ones
  // are the All tools rows whose controls show once the tool is opened).
  const levels = useMemo(() => {
    const out: Record<string, Level> = {};
    const shown = (g: RibbonGroup | null) => !!g && controller.groupShows(g);
    const left = contextual ?? mode;
    for (const g of left?.groups ?? []) {
      if (!shown(g)) continue;
      const collapsed = !contextual && left?.id === 'all-tools' && !HEADER_GROUPS.has(g.id) && g.key !== panel?.key;
      out[g.key] = collapsed ? COLLAPSED : FULL;
    }
    for (const t of bars) for (const g of t.groups) if (shown(g)) out[g.key] = FULL;
    for (const key of [MODE_BAR, ...QUICK, RAIL_PANELS, RAIL_NAV]) if (shown(groupByKey(controller, key))) out[key] = FULL;
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, controller.version, contextual?.id, mode?.id, panel?.key, bars.map(t => t.id).join(','), state.flags]);
  useEffect(() => { controller.setLevels(levels); }, [controller, levels]);

  // Keytips: a collapsed group's letters open it (KeyRouter → setGroupMenu); here that is the tool panel.
  useEffect(() => {
    if (!state.groupMenu) return;
    const key = state.groupMenu;
    controller.setGroupMenu(null);
    try { controller.setPanel(key); setLeftOpen(true); } catch (e) { report(controller, e); }
  }, [state.groupMenu, controller]);

  // view.mode (the mode tabs as commands) and view.palette (Find tools and commands) ask this window to move.
  const modeReq = view.modeReq ?? null;
  useEffect(() => {
    if (!modeReq) return;
    try { controller.setTab(modeReq.mode === 'esign' ? 'e-sign' : modeReq.mode); setLeftOpen(true); } catch (e) { report(controller, e); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeReq?.n, controller]);
  // A look or level chosen after Enhance page enhances the page again from the original: the steps taken are undone first, then the page is
  // enhanced as the corners say and the turns made since are made again (printcraft camera_ui.rs CameraLevel).
  const restyle: number = view.cameraDone?.restyle ?? 0;
  const restyling = useRef(false);
  useEffect(() => {
    if (!restyle || restyling.current) return;
    restyling.current = true;
    const done = view.cameraDone;
    void (async () => {
      try {
        await controller.run('edit.undo', {steps: done.steps}, {origin: 'ui'});
        await controller.run('camera.enhance', {again: true}, {origin: 'ui'});
        const quarters = (((Math.round(done.turns / 90) % 4) + 4) % 4);
        for (let k = 0; k < (quarters === 3 ? 1 : quarters); k++) await controller.run(quarters === 3 ? 'camera.rotate_ccw' : 'camera.rotate_cw', {}, {origin: 'ui'});
      } finally { restyling.current = false; }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restyle, controller]);
  const paletteReq: number = view.paletteReq ?? 0;
  useEffect(() => { if (paletteReq) controller.setMenu('search'); }, [paletteReq, controller]);

  // A stamp picked anywhere opens Add a stamp's tool panel with the palette (printcraft LeftPanel::Tool("stamp")).
  const leftPanel = view.leftPanel ?? null;
  useEffect(() => {
    if (leftPanel !== 'stamp' && leftPanel !== 'form') return;
    try { controller.setTab(`all-tools/${leftPanel}`); setLeftOpen(true); } catch { /* the tool is not translated */ }
  }, [leftPanel, controller]);

  // The rail's Comments and Signatures (view.rightPanel, set by comment.list / sign.panel) show their
  // shell pane; closing the pane closes the panel the same way the rail toggle does.
  const rightPanel: string | null = view.rightPanel ?? null;
  const shownPane = useRef<string | null>(null);
  useEffect(() => {
    const want = rightPanel && RIGHT_PANES[rightPanel] && controller.paneImplemented(RIGHT_PANES[rightPanel].pane) ? RIGHT_PANES[rightPanel].pane : null;
    const panes = controller.getState().panes;
    for (const {pane} of Object.values(RIGHT_PANES)) {
      const open = !!panes.find(p => p.id === pane)?.open;
      if (pane === want && !open) controller.setPane(pane, true);
      else if (pane !== want && open && shownPane.current === pane) controller.setPane(pane, false);
    }
    shownPane.current = want;
  }, [rightPanel, controller]);
  useEffect(() => {
    const cur = shownPane.current;
    if (!cur || !rightPanel) return;
    const entry = Object.values(RIGHT_PANES).find(x => x.pane === cur);
    if (entry && state.panes.some(p => p.id === cur && !p.open)) {
      shownPane.current = null;
      void controller.run(entry.command, {open: false}, {origin: 'ui'});
    }
  }, [state.panes, rightPanel, controller]);

  // The dialogs' own bodies (Certificate Viewer, Sign with a Digital ID, Keyboard shortcuts...) load ahead too, so a dialog opens with its
  // content and never shows the plain fields for a moment first.
  useEffect(() => {
    const stems = Object.keys(((controller as any).ui?.dialogs ?? {}) as Record<string, unknown>);
    const t = setTimeout(() => { for (const stem of stems) { try { void controller.dialogOverride(`dialog.${stem}`)?.().catch(() => {}); } catch { /* not a dialog */ } } }, 0);
    return () => clearTimeout(t);
  }, [controller]);

  // The rail's panes load ahead, so a toggle shows its panel at once.
  useEffect(() => { for (const id of ['comments', 'signatures', 'stamps', 'fields', 'search', 'layers', 'attachments', 'tags']) void preloadPane(controller.paneModule(id), id); }, [controller]);

  const pickMode = (t: RibbonTab) => {
    try {
      // A second click on the shown mode folds its panel away, as Acrobat's tabs do.
      if (t.id === mode?.id && !contextual && !panel) { setLeftOpen(o => !o); return; }
      controller.setTab(t.id); setLeftOpen(true);
    } catch (e) { report(controller, e); }
  };

  const modeBar = groupByKey(controller, MODE_BAR);
  // A property control the tool in use does not have (a fill for the pen, a thickness for the highlighter) is left out, as is a group with none.
  const applies = (c: SpecControl) => !(controller.controlState(c) as {hidden?: boolean}).hidden;
  const quick = QUICK.map(k => groupByKey(controller, k)).filter((g): g is RibbonGroup => !!g && controller.groupShows(g) && controlsOf(g).some(c => controller.shows(c) && applies(c)));
  const toolbars = [...(contextual?.groups ?? []).filter(isToolbarGroup), ...bars.flatMap(t => t.groups)].filter(g => controller.groupShows(g));

  return <div className="fa" data-mode={mode?.id ?? ''} data-panel={panel?.key ?? contextual?.id ?? ''}>
    <header className="fa-modebar" data-chrome-bar role="toolbar" aria-label="Modes">
      <button type="button" className={`fa-iconbtn${state.backstage.open ? ' is-on' : ''}`} data-keytip-id="#file" aria-label="Menu" aria-haspopup="dialog"
        aria-expanded={state.backstage.open} data-tip="Menu" data-tip-desc="Open, save, print, export and the app's settings" onClick={() => controller.openBackstage()}>
        <Icon id="menu" size={20}/>
      </button>
      <span className="fa-vline" aria-hidden="true"/>
      <div className="fa-modes" role="tablist" aria-label="Modes">
        {modes.map(t => {
          const selected = t.id === mode?.id && !state.backstage.open;
          return <button key={t.id} type="button" role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1} className={`fa-mode${selected ? ' is-active' : ''}`}
            data-tab-id={t.id} data-keytip-id={t.id} onClick={() => pickMode(t)}>{t.label}</button>;
        })}
      </div>
      <span className="fa-fill"/>
      <div className="fa-modebar-end">
        {controlsOf(modeBar).filter(c => !MODE_TOGGLES.has(c.id)).map(c => <Control key={c.id} c={c} size="small"/>)}
      </div>
    </header>
    {inlineBars}
    <div className="fa-body">
      {leftOpen && (contextual || mode) ? <aside className="fa-left" aria-label="Tools panel" data-chrome-bar>
        {contextual ? <GroupPanel tab={contextual} title={contextual.label} groups={contextual.groups.filter(g => !isToolbarGroup(g))}
          extra={contextual.id === 'calculation-order' ? <CalcOrderList/> : contextual.id === 'measure-objects' ? <MeasureSaved/> : null}
          lead={contextual.id === 'measure-objects' ? <MeasureReading/> : contextual.id === 'compare' ? <CompareResults/> : null}
          onClose={contextual.id === 'measure-objects' ? () => { void controller.run('measure.panel', {open: false}, {origin: 'ui'}).catch(() => {}); } : undefined}/>
          : mode?.id === 'all-tools' ? (panel ? <ToolPanel group={panel} onBack={() => controller.setPanel(null)}/> : <AllTools tab={mode} onClose={() => { setLeftOpen(false); void controller.run('view.tools_pane', {open: false}, {origin: 'ui'}).catch(() => {}); }}/>)
            : mode ? <GroupPanel tab={mode} title={mode.label} groups={mode.groups} onClose={() => { setLeftOpen(false); void controller.run('view.tools_pane', {open: false}, {origin: 'ui'}).catch(() => {}); }}/> : null}
      </aside> : null}
      {leftPanes}
      <div className="fa-doc">
        <NoticeBar/>
        {toolbars.length ? <div className="fa-docbars" data-chrome-bar>
          {toolbars.map(g => <div key={g.key} className="fa-docbar" role="toolbar" aria-label={g.label} data-group-key={g.key}>
            {g.id === 'grid-toolbar' ? <OrganizeCount/> : <span className="fa-docbar-title">{g.label}</span>}
            {controlsOf(g).filter(c => !isBarEnd(c)).map(c => <Control key={c.id} c={c} size={LABELLED.test(c.id) ? 'medium' : 'small'}/>)}
            <span className="fa-fill"/>
            {controlsOf(g).filter(isBarEnd).sort((a, b) => Number(/close$/.test(a.id)) - Number(/close$/.test(b.id))).map(c => <Control key={c.id} c={c} size="small"/>)}
          </div>)}
        </div> : null}
        <div className="fa-doc-main">
          {surface}
          {view.toolsFull && mode?.id === 'all-tools' && !contextual ? <AllToolsPage tab={mode} query={view.toolsQuery ?? ''}
            onPick={g => { void controller.run('view.tools_full', {open: false}, {origin: 'ui'}).catch(() => {}); try { controller.setPanel(g.key); setLeftOpen(true); } catch (e) { report(controller, e); } }}/> : null}
          {quick.length && doc?.file?.content?.pages?.length && !view.organize && !view.combine?.open ? <div className="fa-quickbar" data-chrome-bar role="toolbar" aria-label="Quick tools" aria-orientation="vertical">
            <FlyoutPlacement.Provider value="right">
              {quick.map((g, i) => <div key={g.key} className={`fa-quick-group${i ? ' is-props' : ''}`} data-group-key={g.key}>
                {controlsOf(g).filter(applies).map(c => <Control key={c.id} c={c} size="small"/>)}
              </div>)}
            </FlyoutPlacement.Provider>
          </div> : null}
        </div>
      </div>
      {rightPanes}
      <Rail/>
    </div>
  </div>;
}

/** A spec control drawn by the ribbon's own components. */
function Control({c, size}: {c: SpecControl; size: 'small' | 'medium'}) {
  return <RibbonControl c={c} size={size}/>;
}

// ---------------------------------------------------------------------------------------------
// The left panel

function PanelHead({title, lead, children}: {title: string; lead?: ReactNode; children?: ReactNode}) {
  return <div className="fa-panel-head">
    {lead}
    <h2 title={title}>{title}</h2>
    <span className="fa-panel-tools">{children}</span>
  </div>;
}

function CloseButton({onClose, label = 'Close panel'}: {onClose: () => void; label?: string}) {
  return <button type="button" className="fa-iconbtn is-small" aria-label={label} data-tip={label} data-tip-keys="Shift+F4" onClick={onClose}><Icon id="x" size={16}/></button>;
}

/** The All tools list: one row per tool (the All tools groups), the first 14 until View more. */
function AllTools({tab, onClose}: {tab: RibbonTab; onClose: () => void}) {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const view: any = (() => { try { return session.get(docId).view ?? {}; } catch { return {}; } })();
  const more = view.toolsMore === true;
  const header = tab.groups.filter(g => HEADER_GROUPS.has(g.id));
  const rows = tab.groups.filter(g => !HEADER_GROUPS.has(g.id) && controller.groupShows(g));
  const headerControls = header.flatMap(controlsOf).filter(c => controller.shows(c));
  const shown = more ? rows : rows.slice(0, COLLAPSED_TOOLS);
  const viewMore = headerControls.find(c => c.id === 'alltools.panel.view-more');
  return <div className="fa-panel" data-panel-id={tab.id}>
    <PanelHead title={tab.label}>
      {headerControls.filter(c => c.type !== 'combo' && c.id !== 'alltools.panel.view-more' && c.id !== 'alltools.panel.collapse').map(c => <Control key={c.id} c={c} size="small"/>)}
      {!headerControls.some(c => /close/.test(c.id)) ? <CloseButton onClose={onClose}/> : null}
    </PanelHead>
    <div className="fa-panel-body" role="list" aria-label="Tools">
      {shown.map(g => <button key={g.key} type="button" role="listitem" className="fa-tool-row" data-group-key={g.key} data-keytip-id={`#group:${g.key}`}
        aria-label={g.label} onClick={() => controller.setPanel(g.key)}>
        <span className="fa-tool-icon">{g.collapsedIcon ? <Icon id={g.collapsedIcon} size={20}/> : null}</span>
        <span className="fa-tool-label">{g.label}</span>
      </button>)}
      {rows.length > COLLAPSED_TOOLS && viewMore ? <button type="button" className="fa-link" data-control-id={viewMore.id} aria-pressed={more}
        onClick={() => void controller.activate(viewMore.id).catch(e => report(controller, e))}>{more ? 'View less' : 'View more'}</button> : null}
    </div>
  </div>;
}

/** One tool opened from All tools (printcraft tool_detail): Back, its name, then its tools. */
function ToolPanel({group, onBack}: {group: RibbonGroup; onBack: () => void}) {
  const {controller} = useEngine();
  const stamp = group.key === 'all-tools/stamp' && controller.paneImplemented('stamps') ? 'stamps' : null;
  return <div className="fa-panel" data-panel-id={group.key}>
    <PanelHead title={group.label} lead={<button type="button" className="fa-iconbtn is-small" aria-label="Back to all tools" data-tip="Back to all tools" onClick={onBack}><Icon id="chevron-left" size={16}/></button>}/>
    <div className="fa-panel-body">
      <Section group={group} titled={false}/>
      {stamp ? <div className="fa-pane-embed"><PaneBody id={stamp}/></div> : null}
    </div>
  </div>;
}

/** A mode's panel (Edit, Convert, E-Sign) or a contextual panel (Organize pages, Measure...): its groups as sections. */
function GroupPanel({tab, title, groups, onClose, extra, lead}: {tab: RibbonTab; title: string; groups: RibbonGroup[]; onClose?: () => void; extra?: ReactNode; lead?: ReactNode}) {
  const {controller} = useEngine();
  const header = groups.filter(g => HEADER_GROUPS.has(g.id)).flatMap(controlsOf).filter(c => controller.shows(c));
  const sections = groups.filter(g => !HEADER_GROUPS.has(g.id) && controller.groupShows(g));
  return <div className="fa-panel" data-panel-id={tab.id}>
    <PanelHead title={title}>
      {header.map(c => <Control key={c.id} c={c} size="small"/>)}
      {onClose && !header.some(c => /close/.test(c.id)) ? <CloseButton onClose={onClose}/> : null}
    </PanelHead>
    <div className="fa-panel-body">
      {lead}
      {sections.map(g => <Section key={g.key} group={g} titled/>)}
      {!sections.length && !extra ? <p className="fa-empty">Nothing here is available yet.</p> : null}
      {extra}
    </div>
  </div>;
}

/** Sections folded by the person (a panel's sections fold as Acrobat's do; kept while the window is open). */
const folded = new Set<string>();
/** Sections that start folded (the snap options of the Measure panel: set once, so the panel's scale controls fit without scrolling); unfolding one is remembered. */
const FOLDED_AT_FIRST = new Set(['measure-objects/snap-to-drawing']);
const unfolded = new Set<string>();

function Section({group, titled}: {group: RibbonGroup; titled: boolean}) {
  const {controller} = useEngine();
  const [closed, setClosed] = useState(() => folded.has(group.key) || (FOLDED_AT_FIRST.has(group.key) && !unfolded.has(group.key)));
  const fold = () => setClosed(c => { if (c) { folded.delete(group.key); unfolded.add(group.key); } else { folded.add(group.key); unfolded.delete(group.key); } return !c; });
  const list = controlsOf(group).filter(c => controller.shows(c));
  const lead = ICON_ROWS[group.key] ?? 0;
  const iconRow: SpecControl[] = [];
  for (const c of list) { if (iconRow.length >= lead || !(c.type === 'button' || c.type === 'toggle') || !c.icon) break; iconRow.push(c); }
  const rest = list.slice(iconRow.length);
  return <section className="fa-section" data-group-key={group.key} aria-label={group.label}>
    {titled ? <h3><button type="button" className="fa-fold" aria-expanded={!closed} onClick={fold}><Icon id={closed ? 'chevron-right' : 'chevron-down'} size={16}/>{group.label}</button></h3> : null}
    {closed ? null : <>
    {iconRow.length ? <div className="fa-icon-row">{iconRow.map(c => <Control key={c.id} c={c} size="small"/>)}</div> : null}
    {rest.map(c => <div key={c.id} className={`fa-row is-${c.type}`}>
      {c.type === 'combo' || c.type === 'spinner' ? <><span className="fa-row-label">{displayLabel(c)}</span><RibbonControl c={c.type === 'spinner' ? {...c, noLabel: true} : c} size="medium"/></> : <Control c={c} size="medium"/>}
    </div>)}
    </>}
  </section>;
}

/**
 * The calculation order panel's list (printcraft tools/calc_order_ui.rs): the calculated fields in the
 * order they recalculate, what each reads and what is wrong with its place; a click picks the field
 * (Earlier / Later and Edit formula act on it).
 */
function CalcOrderList() {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const [order, setOrder] = useState<any>(null);
  const view: any = (() => { try { return session.get(docId).view; } catch { return {}; } })();
  useEffect(() => {
    let alive = true;
    controller.run('form.calc.read', {}, {origin: 'ui'}).then((r: any) => { if (alive) setOrder(r?.result ?? null); }).catch(() => { if (alive) setOrder(null); });
    return () => { alive = false; };
  }, [controller, tick]);
  const say = (i: any) => i.kind === 'missing_field' ? `Reads ${i.field}, which the form doesn't have` : i.kind === 'runs_too_early' ? `Runs before ${i.field}, which it reads` : i.kind === 'cycle' ? `Reads itself through ${i.fields.join(', ')}`
    : i.kind === 'built_names' ? "Also reads fields by names it builds when it runs, so the order isn't checked against them" : 'Left out of the order the form lists (/CO)';
  return <section className="fa-section" aria-label="Calculated fields">
    <h3>{order ? `${order.fields.length} calculated ${order.fields.length === 1 ? 'field' : 'fields'}` : 'Calculated fields'}</h3>
    <div className="fa-calc-list" role="listbox" aria-label="Calculation order">
      {(order?.fields ?? []).map((f: any, i: number) => <div key={f.name} role="option" aria-selected={view.calcSel === f.name} className={`fa-calc-row${view.calcSel === f.name ? ' is-selected' : ''}${f.issues.length ? ' has-issues' : ''}`}
        onClick={() => void controller.run('form.calc.select', {name: f.name}, {origin: 'ui'})}>
        <b><span className="fa-calc-n">{i + 1}</span>{f.name}</b>
        <small>{f.reads.length ? `Reads ${f.reads.join(', ')}` : 'Reads no fields'}</small>
        {f.issues.map((x: any, k: number) => <small key={k} className="fa-calc-issue">{say(x)}</small>)}
      </div>)}
      {order && !order.fields.length ? <p className="fa-empty">No field has a calculation. Add one on a field's Calculate tab.</p> : null}
    </div>
    {order?.extra?.length ? <small className="fa-calc-issue">/CO also lists {order.extra.join(', ')}, which calculate nothing.</small> : null}
  </section>;
}

/** Organize pages' bar (printcraft organize_toolbar): "Page n of N" or how many pages are selected. */
function OrganizeCount() {
  const {session, docId} = useEngine();
  useSessionTick();
  const doc: any = (() => { try { return session.get(docId); } catch { return null; } })();
  const pages = doc?.file?.content?.pages?.length ?? 0;
  const selected = selectedIndices(doc?.selection, doc?.file?.content?.pages ?? []).length;
  const current = (viewOf(docId)?.current ?? 0) + 1;
  const text = selected === 0 ? `Page ${current} of ${pages}` : selected === 1 ? '1 page selected' : `${selected} pages selected`;
  return <span className="fa-docbar-title" aria-live="polite">{text}</span>;
}

// ---------------------------------------------------------------------------------------------
// The right rail

function Rail() {
  const {controller, session, docId} = useEngine();
  useShellState();
  useSessionTick();
  const panels = controlsOf(groupByKey(controller, RAIL_PANELS));
  const nav = controlsOf(groupByKey(controller, RAIL_NAV));
  const doc: any = (() => { try { return session.get(docId); } catch { return null; } })();
  const content = doc?.file?.content;
  const count: number = content?.pages?.length ?? 0;
  const live = viewOf(docId);
  const current = Math.min(Math.max(0, live?.current ?? 0), Math.max(0, count - 1));
  const label = count ? pageLabel(content, current) : '';
  // printcraft right_rail draws the cluster bottom-up: zoom out lowest, the page box on top.
  const cluster = [...nav].reverse();
  return <aside className="fa-rail" data-chrome-bar aria-label="Panels and page navigation">
    <div className="fa-rail-panels" role="toolbar" aria-orientation="vertical" aria-label="Panels">
      <FlyoutPlacement.Provider value="right">{panels.map(c => <Control key={c.id} c={c} size="small"/>)}</FlyoutPlacement.Provider>
    </div>
    <div className="fa-rail-nav" role="group" aria-label="Page navigation and zoom">
      <FlyoutPlacement.Provider value="right">
        {cluster.map(c => c.id === 'rail.nav.page-input' ? (controller.shows(c) && count ? <PageBox key={c.id} c={c} label={label} current={current} count={count}/> : null)
          : c.id === 'rail.nav.position' ? (count ? <span key={c.id} className="fa-rail-position" data-tip={`Page ${current + 1} of ${count}`} data-control-id={c.id}>{label !== String(current + 1) ? `${current + 1}/${count}` : String(count)}</span> : null)
            : c.type === 'combo' ? <div key={c.id} className="fa-rail-zoom"><RibbonControl c={c} size="small" width={44}/></div>
              : <Control key={c.id} c={c} size="small"/>)}
      </FlyoutPlacement.Provider>
    </div>
  </aside>;
}

/** The current page box (printcraft chrome.rs:691): type a page label (such as iv) or number and press Enter. */
function PageBox({c, label, current, count}: {c: SpecControl; label: string; current: number; count: number}) {
  const {controller} = useEngine();
  const [text, setText] = useState<string | null>(null);
  const go = (v: string) => {
    setText(null);
    if (!v.trim() || v.trim() === label) return;
    controller.activate(c.id, {value: v.trim()}).catch(e => report(controller, e));
  };
  return <label className="fa-pagebox" data-control-id={c.id} data-keytip-id={c.id} data-tip="Current page" data-tip-desc="Type a page number or label (such as iv) and press Enter"
    data-tip-keys="Ctrl+Shift+N">
    <input aria-label={`Current page, ${current + 1} of ${count}`} value={text ?? label} onChange={e => setText(e.target.value)} onFocus={e => e.target.select()}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); go(text ?? label); controller.focusSurface(); } else if (e.key === 'Escape') { e.preventDefault(); setText(null); controller.focusSurface(); } }}
      onBlur={() => setText(null)}/>
  </label>;
}

// ---------------------------------------------------------------------------------------------
// A shell pane's body inside a tool panel (Add a stamp's palette)

const paneCache = new Map<string, LazyExoticComponent<ComponentType<PaneProps>>>();
function PaneBody({id}: {id: string}) {
  const {controller} = useEngine();
  const loader = controller.paneModule(id);
  const Body = useMemo(() => {
    if (!loader) return null;
    if (!paneCache.has(id)) paneCache.set(id, lazy(async () => { const m = await loader(); return {default: (m.default ?? m.Pane) as ComponentType<PaneProps>}; }));
    return paneCache.get(id)!;
  }, [loader, id]);
  if (!Body) return null;
  return <Suspense fallback={null}><Body paneId={id} close={() => controller.setPanel(null)}/></Suspense>;
}

/**
 * The Measure panel's reading (printcraft tools/measure_ui.rs panel_body, Measurement information): what to do, then the live reading
 * of the measurement being drawn with its X and Y, its angle and the scale it reads in.
 */
function MeasureReading() {
  const {session, docId} = useEngine();
  useSessionTick();
  const view: any = (() => { try { return session.get(docId).view ?? {}; } catch { return {}; } })();
  const r = view.measure?.readout ?? null;
  return <section className="fa-section fa-measure-reading" aria-label="Measuring">
    <p className="fa-hint">Click vertices. Enter or double-click finishes a perimeter or area. Click the first point to close an area.</p>
    <p className="fa-hint">Shift constrains to 45 degrees. Backspace removes a vertex. Escape cancels.</p>
    <div className="fa-readout" aria-live="polite" data-readout={r ? 'live' : 'idle'}>
      {r ? <>
        <b>{r.label}</b>
        <span>X: {Number(r.deltaX ?? 0).toFixed(3)}   Y: {Number(r.deltaY ?? 0).toFixed(3)}</span>
        <span>Angle: {Number(r.angle ?? 0).toFixed(2)}°</span>
        {r.ratio ? <span>{r.ratio}</span> : null}
      </> : <span>Click the first point to begin.</span>}
    </div>
  </section>;
}

/**
 * The Measure panel's viewport rectangle and name (shown when Entire page is off) and its list of saved measurements: a click goes to
 * the measurement and selects it (measure_ui.rs panel_body: the list, Unsupported measurements).
 */
function MeasureSaved() {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const doc: any = (() => { try { return session.get(docId); } catch { return null; } })();
  const view: any = doc?.view ?? {};
  const pages: any[] = doc?.file?.content?.pages ?? [];
  const key = `${doc?.file?.content?.sourceBase64?.length ?? 0}|${pages.map(p => p.annots?.length ?? 0).join(',')}`;
  const [info, setInfo] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    controller.run('measure.info', {}, {origin: 'ui'}).then((r: any) => { if (alive) setInfo(r?.result ?? null); }).catch(() => { if (alive) setInfo(null); });
    return () => { alive = false; };
  }, [controller, key]);
  const m = view.measure ?? {};
  const rect: number[] = m.rect ?? [0, 0, 100, 100];
  const set = (params: Record<string, unknown>) => void controller.run('measure.options', params, {origin: 'ui'}).catch((e: unknown) => controller.notify(toCommandError(e).message, 'error'));
  const go = (item: any) => {
    const page = pages[item.page - 1];
    if (!page) return;
    const a = `/pg:${encodeURIComponent(page.id)}/annot:${encodeURIComponent(item.id)}`;
    session.setSelection(docId, {ranges: [{anchor: a, focus: a}], primary: 0});
    void controller.run('tool.select', {}, {origin: 'ui'}).catch(() => {});
    viewOf(docId)?.goToPage(item.page - 1);
  };
  const list: any[] = info?.measurements ?? [];
  return <>
    {m.wholePage === false ? <section className="fa-section" aria-label="Viewport">
      <h3>Viewport rectangle in page points</h3>
      <div className="fa-fields">
        {['X', 'Y', 'Width', 'Height'].map((name, i) => <label key={name}>{name}
          <input type="number" min={0} aria-label={name} defaultValue={rect[i]} key={`${name}${rect[i]}`}
            onBlur={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v) && v >= 0 && v !== rect[i]) set({rect: rect.map((x, j) => (j === i ? v : x))}); }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/>
        </label>)}
      </div>
      <label className="fa-field-wide">Viewport
        <input type="text" maxLength={128} aria-label="Viewport name" defaultValue={m.name ?? 'Drawing scale'} key={m.name}
          onBlur={e => { const v = e.currentTarget.value.trim(); if (v && v !== m.name) set({name: v}); }}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/>
      </label>
    </section> : null}
    <section className="fa-section" aria-label="Saved measurements" data-count={list.length}>
      <h3>Saved measurements: {list.length}</h3>
      {info?.unsupported?.length ? <small className="fa-calc-issue" title={info.unsupported.map((u: any) => `Page ${u.page}: ${u.reason}`).join('\n')}>Unsupported measurements: {info.unsupported.length}</small> : null}
      <div className="fa-saved-list" role="list">
        {list.map((x: any) => <button key={x.id} type="button" role="listitem" className="fa-saved" onClick={() => go(x)}>{`Page ${x.page}: ${x.reading.label} ${x.label}`.trim()}</button>)}
      </div>
    </section>
  </>;
}

/** Compare's colours (printcraft engine compare.rs colour): replaced blue, inserted green, deleted red. */
const COMPARE_COLOURS: Record<string, string> = {Replaced: 'rgb(51, 115, 242)', Inserted: 'rgb(51, 191, 77)', Deleted: 'rgb(230, 64, 64)'};

/**
 * The Compare panel (printcraft workflows/compare_ui.rs panel): how many differences of each kind, then each one with its kind and page;
 * a click goes to it in the new file. Both files' names say what was compared.
 */
function CompareResults() {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  const view: any = (() => { try { return session.get(docId).view ?? {}; } catch { return {}; } })();
  const c = view.compare;
  if (!c) return <p className="fa-empty">Compare this file with an older version: Compare files… in All tools.</p>;
  const changes: any[] = c.changes ?? [];
  const n = (kind: string) => changes.filter(x => x.kind === kind).length;
  return <section className="fa-section fa-compare" aria-label="Differences" data-count={changes.length}>
    <p className="fa-hint">{c.oldName} → {c.newName}</p>
    {!changes.length ? <p className="fa-hint">No differences in the text.</p> : null}
    <div className="fa-compare-counts">
      {['Replaced', 'Inserted', 'Deleted'].map(k => <span key={k}><i style={{background: COMPARE_COLOURS[k]}}/>{n(k)} {k}</span>)}
    </div>
    {c.showText ? <div className="fa-compare-list" role="list">
      {changes.slice(0, 2000).map((ch, i) => <button key={i} type="button" role="listitem" className={`fa-compare-row${c.selected === i ? ' is-selected' : ''}`}
        onClick={() => void controller.run('compare.select', {index: i + 1}, {origin: 'ui'}).catch(() => {})}>
        <b style={{background: COMPARE_COLOURS[ch.kind]}}/>
        <span>
          <small>{ch.kind} · page {ch.new.page + 1}</small>
          {ch.kind === 'Replaced' ? `"${ch.old.text}" → "${ch.new.text}"` : ch.kind === 'Inserted' ? `+ "${ch.new.text}"` : `− "${ch.old.text}"`}
        </span>
      </button>)}
    </div> : null}
  </section>;
}
