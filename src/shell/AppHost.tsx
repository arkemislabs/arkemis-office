// AppHost (docs/architecture.md sections 2 and 16): mounts the window frame, the ribbon, the app's
// editing surface, panes, dialogs, the backstage and keytips for one document of one app. Every
// part reads the same ShellController, which RendererBridge drives for `ui.*` requests.

import {Suspense, lazy, useEffect, useMemo, type ComponentType, type ReactNode} from 'react';
import type {AppId} from '../generated/spec-types';
import {EngineProvider, useEngine, type HostFile} from './engine/EngineProvider';
import {useShellState} from './engine/useCommand';
import {TitleBar} from './chrome/TitleBar';
import {SpecRibbon} from './ribbon/SpecRibbon';
import {StatusBar} from './statusbar/StatusBar';
import {PaneHost} from './panes/PaneHost';
import {DialogHost, InlineBars} from './dialogs/DialogHost';
import {Backstage} from './backstage/Backstage';
import {KeyTips} from './keys/KeyTips';
import {fieldOwns, chordFromEvent, chordText} from './keys/KeyRouter';
import {TooltipLayer} from './common/Flyout';
import {ContextMenu, defaultContext, contextTargetAt} from './ribbon/ContextMenu';
import type {ShellController, SurfaceHandle} from './engine/ShellController';
import {SHOW_PENDING, platform} from './env';
import './shell.css';

const Diagnostics = process.env.ARKEMIS_DIAGNOSTICS === '1' ? lazy(() => import('./diagnostics/Diagnostics')) : null;

/** What an app's surface (src/apps/<app>/surface, named by manifest.surface) receives. */
export interface SurfaceProps {
  controller: ShellController;
  docId: string;
  /** Register focus/preview/flags/render hooks; returns the unregister function. */
  register: (handle: SurfaceHandle) => () => void;
}

/**
 * What an app's own chrome (manifest.chrome) receives in place of the ribbon and the panes row: the
 * shell's parts to place (the surface, the inline bars, the pane hosts). The title bar, status bar,
 * backstage, dialogs, right-click menus and keytips stay the shell's. Its controls render through
 * ribbon/controls.tsx so activation, state and menus are the ribbon's; it reports the groups it
 * draws with controller.setLevels so ui.inspect lists what is on screen.
 */
export interface ChromeProps {
  controller: ShellController;
  surface: ReactNode;
  inlineBars: ReactNode;
  leftPanes: ReactNode;
  rightPanes: ReactNode;
}

export interface AppHostProps {
  kind: AppId;
  file: HostFile;
  saving?: boolean;
  onChange: (patch: {content: unknown; title: string; [key: string]: unknown}) => void;
  onSave: () => Promise<HostFile | null | undefined>;
  onClose: () => void;
  onExport?: (file: HostFile, format: string) => Promise<string | null>;
}

export default function AppHost(props: AppHostProps) {
  return <EngineProvider kind={props.kind} file={props.file} onChange={props.onChange} onSave={props.onSave} onClose={props.onClose} onExport={props.onExport}
    fallback={<div className="shell shell-booting" data-app={props.kind}><div className="shell-loading" aria-busy="true">Opening…</div></div>}>
    <Shell saving={props.saving} onBack={props.onClose}/>
  </EngineProvider>;
}

function Shell({saving, onBack}: {saving?: boolean; onBack: () => void}) {
  const {controller, kind, ui} = useEngine();
  const state = useShellState();

  // Keyboard routing: one capture-phase listener; fields keep their own typing keys.
  useEffect(() => controller.router.attach(window, e => {
    const t = e.target as HTMLElement | null;
    if (!t || !t.closest) return false;
    if (t.closest('.shell-surface') && !t.closest('input,textarea,select')) return false;
    const field = t.closest('input,textarea,select,[contenteditable=true]');
    if (!field) return false;
    const chord = chordFromEvent(e);
    return !!chord && fieldOwns(chordText(chord, platform()), field.tagName === 'TEXTAREA' || field.getAttribute('contenteditable') === 'true');
  }), [controller]);

  useEffect(() => { document.title = `${(() => { try { return controller.session.get(controller.docId).file.title; } catch { return ''; } })()} — Arkemis`; });

  // Right-click menus (Office's context menus): the element under the pointer names its target
  // (data-context or the app's selector table), else the surface answers for its own content.
  const openContext = async (x: number, y: number, el: Element | null) => {
    const fromDom = contextTargetAt(kind, el);
    let target = fromDom;
    if (!target && el?.closest('.shell-surface')) target = (await controller.view?.contextMenu?.(x, y)) ?? defaultContext(kind, controller.getState().flags);
    if (target) controller.openContextMenu(target, x, y);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey))) return;
      const el = document.activeElement;
      if (el?.closest('input,textarea,select,.shell-flyout')) return;
      e.preventDefault();
      const r = (el?.closest('[data-context], .shell-surface') ?? document.querySelector('.shell-surface'))?.getBoundingClientRect();
      if (r) void openContext(r.left + Math.min(r.width / 2, 160), r.top + Math.min(r.height / 2, 120), el?.closest('.shell-surface') ? document.querySelector('.shell-surface') : el);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const Surface = ui.manifest?.surface as ComponentType<SurfaceProps> | undefined;
  const register = useMemo(() => (handle: SurfaceHandle) => {
    controller.view = handle;
    controller.refreshFlags(false);
    return () => { if (controller.view === handle) controller.view = null; };
  }, [controller]);

  // An app's own chrome (manifest.chrome: PDF's Acrobat layout) replaces the ribbon and the panes row.
  const Chrome = ui.manifest?.chrome as ComponentType<ChromeProps> | undefined;
  const surface = <div className="shell-surface" role="main" aria-label="Document">
    {Surface ? <Surface controller={controller} docId={controller.docId} register={register}/> : <PlaceholderSurface/>}
  </div>;

  return <div className={`shell${Chrome ? ' has-chrome' : ''}${state.backstage.open ? ' has-backstage' : ''}${SHOW_PENDING ? ' shows-pending' : ''}${state.busy ? ' is-busy' : ''}`} data-app={kind}
    onContextMenu={e => {
      const el = e.target as Element;
      // Text fields keep the system's Cut/Copy/Paste menu.
      if (el.closest('input,textarea,select,[contenteditable=true]') && !el.closest('.shell-surface')) return;
      e.preventDefault();
      if (state.backstage.open || el.closest('.shell-flyout, .shell-dialog, .shell-ribbon, .shell-titlebar, [data-chrome-bar]')) return;
      void openContext(e.clientX, e.clientY, el);
    }}>
    <TitleBar saving={saving} onBack={onBack}/>
    {Chrome ? <Chrome controller={controller} surface={surface} inlineBars={<InlineBars/>} leftPanes={<PaneHost side="left"/>} rightPanes={<PaneHost side="right"/>}/> : <>
      <SpecRibbon/>
      <InlineBars/>
      <div className="shell-main">
        <PaneHost side="left"/>
        {surface}
        <PaneHost side="right"/>
      </div>
    </>}
    {ui.manifest?.statusBar === false ? null : <StatusBar saving={saving}/>}
    <Backstage/>
    <DialogHost/>
    <ContextMenu/>
    <KeyTips/>
    <Toast/>
    <TooltipLayer/>
    {Diagnostics ? <Suspense fallback={null}><Diagnostics/></Suspense> : null}
  </div>;
}

/** Until the app's foundation ships its surface (manifest.surface), a quiet page of the right shape. */
function PlaceholderSurface() {
  const {kind} = useEngine();
  return <div className={`shell-placeholder is-${kind}`} tabIndex={-1}>
    <div className="shell-paper" aria-hidden="true">
      {kind === 'grid' ? <div className="shell-paper-grid">{Array.from({length: 18 * 9}, (_, i) => <i key={i}/>)}</div>
        : kind === 'prism' ? <div className="shell-paper-slide"><b/><i/><i/></div>
          : <div className="shell-paper-lines"><b/>{Array.from({length: 9}, (_, i) => <i key={i} style={{width: `${[96, 92, 98, 64, 0, 94, 90, 97, 58][i]}%`}}/>)}</div>}
    </div>
    {SHOW_PENDING ? <p className="shell-placeholder-note">The {kind} editing surface arrives with its foundation (src/apps/{kind}/surface).</p> : null}
  </div>;
}

function Toast() {
  const {controller} = useEngine();
  const state = useShellState();
  const t = state.toast;
  useEffect(() => {
    if (!t) return;
    const timer = setTimeout(() => controller.dismissToast(t.id), t.tone === 'error' ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [t, controller]);
  if (!t) return null;
  return <div className={`shell-toast is-${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
    <span>{t.text}</span><button type="button" aria-label="Dismiss" onClick={() => controller.dismissToast(t.id)}>×</button>
  </div>;
}
